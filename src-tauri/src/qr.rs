use std::{collections::BTreeSet, io::Cursor};

use image::{DynamicImage, ImageDecoder};

const QR_PNG_MAX_BYTES: usize = 64 * 1024 * 1024;
const QR_DIMENSION_MAX: u32 = 8_192;
const QR_PIXEL_MAX: u64 = 40_000_000;
const QR_DECODER_MAX_BYTES: u64 = 192 * 1024 * 1024;
pub(crate) const QR_RESULT_MAX_BYTES: usize = 16 * 1024;
pub(crate) const QR_RESULT_MAX_COUNT: usize = 8;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum QrFailure {
    Oversized,
    Decode,
}

fn validate_dimensions(width: u32, height: u32) -> Result<(), QrFailure> {
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or(QrFailure::Oversized)?;
    if width == 0
        || height == 0
        || width > QR_DIMENSION_MAX
        || height > QR_DIMENSION_MAX
        || pixels > QR_PIXEL_MAX
    {
        return Err(QrFailure::Oversized);
    }
    Ok(())
}

pub(crate) fn decode_qr_png(png: &[u8]) -> Result<Vec<String>, QrFailure> {
    if png.len() > QR_PNG_MAX_BYTES {
        return Err(QrFailure::Oversized);
    }
    if !png.starts_with(PNG_SIGNATURE) {
        return Err(QrFailure::Decode);
    }
    let decoder =
        image::codecs::png::PngDecoder::new(Cursor::new(png)).map_err(|_| QrFailure::Decode)?;
    let (width, height) = decoder.dimensions();
    validate_dimensions(width, height)?;
    if decoder.total_bytes() > QR_DECODER_MAX_BYTES {
        return Err(QrFailure::Oversized);
    }
    let gray = DynamicImage::from_decoder(decoder)
        .map_err(|_| QrFailure::Decode)?
        .into_luma8();
    let mut prepared = rqrr::PreparedImage::prepare(gray);
    let mut seen = BTreeSet::new();
    let mut results = Vec::new();
    for grid in prepared.detect_grids() {
        let Ok((_, content)) = grid.decode() else {
            continue;
        };
        if content.trim().is_empty()
            || content.as_bytes().contains(&0)
            || content.len() > QR_RESULT_MAX_BYTES
            || !seen.insert(content.clone())
        {
            continue;
        }
        results.push(content);
        if results.len() == QR_RESULT_MAX_COUNT {
            break;
        }
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use image::{DynamicImage, GrayImage, ImageFormat, Luma};

    use super::*;

    fn png_bytes(image: GrayImage) -> Vec<u8> {
        let mut output = Cursor::new(Vec::new());
        DynamicImage::ImageLuma8(image)
            .write_to(&mut output, ImageFormat::Png)
            .expect("encode PNG fixture");
        output.into_inner()
    }

    #[test]
    fn decodes_qr_text_from_a_bounded_png() {
        let image = qrcode::QrCode::new("https://quickpaste.example/本地二维码")
            .expect("build QR fixture")
            .render::<Luma<u8>>()
            .min_dimensions(256, 256)
            .build();

        assert_eq!(
            decode_qr_png(&png_bytes(image)),
            Ok(vec!["https://quickpaste.example/本地二维码".into()])
        );
    }

    #[test]
    fn distinguishes_no_code_from_invalid_or_oversized_pngs() {
        assert_eq!(
            decode_qr_png(&png_bytes(GrayImage::new(32, 32))),
            Ok(Vec::new())
        );
        assert_eq!(decode_qr_png(b"not a PNG"), Err(QrFailure::Decode));
        assert_eq!(
            decode_qr_png(&png_bytes(GrayImage::new(8_193, 1))),
            Err(QrFailure::Oversized)
        );
    }
}
