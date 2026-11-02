use std::{
    fs::File,
    io::{Cursor, Read},
    path::Path,
};

use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};

use crate::{
    clipboard_formats::{self, FormatPackage},
    ClipboardSnapshot,
};

// 资源管理器和多文件复制仍是文件操作；聊天等应用的单张图片则保存内容，
// 避免临时缓存被清理后历史只剩失效路径。只处理新捕获，不迁移旧记录。
pub(crate) fn promote_file_image(snapshot: ClipboardSnapshot, source: &str) -> ClipboardSnapshot {
    let ClipboardSnapshot::Package(ref package) = snapshot else {
        return snapshot;
    };
    if source.is_empty()
        || source.eq_ignore_ascii_case("explorer")
        || source.eq_ignore_ascii_case("explorer.exe")
    {
        return snapshot;
    }
    read_single_image(package).unwrap_or(snapshot)
}

fn read_single_image(package: &FormatPackage) -> Option<ClipboardSnapshot> {
    let [file] = package.files.as_slice() else {
        return None;
    };
    let path = Path::new(&file.path);
    // 不访问网络共享或设备路径；扩展名只是初筛，解码格式以文件头为准。
    if !path.is_absolute()
        || file.directory
        || file.path.starts_with("\\\\")
        || file.path.starts_with("//")
        || !matches!(
            file.extension.as_deref()?.to_ascii_lowercase().as_str(),
            "png" | "jpg" | "jpeg" | "bmp"
        )
    {
        return None;
    }
    let input = File::open(path).ok()?;
    let metadata = input.metadata().ok()?;
    let max = clipboard_formats::MAX_CLIPBOARD_IMAGE_SOURCE_BYTES;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > max as u64 {
        return None;
    }
    let mut bytes = Vec::new();
    input.take(max as u64 + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() > max {
        return None;
    }
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    if !matches!(
        reader.format(),
        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Bmp)
    ) {
        return None;
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(clipboard_formats::MAX_CLIPBOARD_IMAGE_DIMENSION as u32);
    limits.max_image_height = Some(clipboard_formats::MAX_CLIPBOARD_IMAGE_DIMENSION as u32);
    limits.max_alloc = Some(max as u64);
    reader.limits(limits);
    let decoder = reader.into_decoder().ok()?;
    if decoder.total_bytes() > max as u64 {
        return None;
    }
    let (width, height) = decoder.dimensions();
    let rgba_len = (width as usize)
        .checked_mul(height as usize)?
        .checked_mul(4)?;
    if !clipboard_formats::clipboard_rgba_layout_is_safe(width as usize, height as usize, rgba_len)
    {
        return None;
    }
    let image = DynamicImage::from_decoder(decoder).ok()?.to_rgba8();
    Some(ClipboardSnapshot::Image {
        width: width as usize,
        height: height as usize,
        bytes: image.into_raw(),
        omitted_formats: package
            .omitted_formats
            .iter()
            .copied()
            .filter(|format| *format != clipboard_formats::ClipboardFormatKind::Image)
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_chat_image_survives_source_deletion_and_preserves_pixels() {
        for (format, extension) in [
            (ImageFormat::Png, "png"),
            (ImageFormat::Jpeg, "jpg"),
            (ImageFormat::Bmp, "bmp"),
        ] {
            let path = std::env::temp_dir().join(format!(
                "quickpaste-image-{}-{extension}.{extension}",
                std::process::id()
            ));
            image::RgbImage::from_pixel(3, 2, image::Rgb([60, 100, 140]))
                .save_with_format(&path, format)
                .unwrap();
            let package =
                clipboard_formats::prepare_file_package(&[path.to_string_lossy().into_owned()])
                    .unwrap();
            let snapshot =
                promote_file_image(ClipboardSnapshot::Package(package.clone()), "Weixin");
            assert!(matches!(
                promote_file_image(ClipboardSnapshot::Package(package.clone()), "explorer"),
                ClipboardSnapshot::Package(_)
            ));
            assert!(matches!(
                promote_file_image(ClipboardSnapshot::Package(package.clone()), ""),
                ClipboardSnapshot::Package(_)
            ));
            let mut multiple = package.clone();
            multiple.files.push(multiple.files[0].clone());
            assert!(matches!(
                promote_file_image(ClipboardSnapshot::Package(multiple), "Weixin"),
                ClipboardSnapshot::Package(_)
            ));
            std::fs::remove_file(&path).unwrap();
            let payload = crate::snapshot_payload(snapshot, None).unwrap();
            assert_eq!(payload.kind, "image");
            assert_eq!((payload.width, payload.height), (Some(3), Some(2)));
            let decoded = crate::decode_clipboard_image(&payload.content).unwrap();
            assert_eq!(decoded.bytes.len(), 24);
            assert_eq!(decoded.bytes[3], 255);
            assert!(matches!(
                promote_file_image(ClipboardSnapshot::Package(package), "Weixin"),
                ClipboardSnapshot::Package(_)
            ));
        }
    }

    #[test]
    fn invalid_remote_and_oversized_images_remain_files() {
        let path = std::env::temp_dir().join(format!(
            "quickpaste-invalid-image-{}.png",
            std::process::id()
        ));
        std::fs::write(&path, b"not an image").unwrap();
        let package =
            clipboard_formats::prepare_file_package(&[path.to_string_lossy().into_owned()])
                .unwrap();
        assert!(matches!(
            promote_file_image(ClipboardSnapshot::Package(package.clone()), "Weixin"),
            ClipboardSnapshot::Package(_)
        ));
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(clipboard_formats::MAX_CLIPBOARD_IMAGE_SOURCE_BYTES as u64 + 1)
            .unwrap();
        drop(file);
        assert!(matches!(
            promote_file_image(ClipboardSnapshot::Package(package), "Weixin"),
            ClipboardSnapshot::Package(_)
        ));
        image::RgbImage::new(8193, 1)
            .save_with_format(&path, ImageFormat::Png)
            .unwrap();
        let package =
            clipboard_formats::prepare_file_package(&[path.to_string_lossy().into_owned()])
                .unwrap();
        assert!(matches!(
            promote_file_image(ClipboardSnapshot::Package(package), "Weixin"),
            ClipboardSnapshot::Package(_)
        ));
        std::fs::remove_file(path).unwrap();
        let remote =
            clipboard_formats::prepare_file_package(&[r"\\server\share\image.png".into()]).unwrap();
        assert!(matches!(
            promote_file_image(ClipboardSnapshot::Package(remote), "Weixin"),
            ClipboardSnapshot::Package(_)
        ));
    }

    #[test]
    fn recovered_file_image_does_not_claim_the_image_format_was_omitted() {
        let path = std::env::temp_dir().join(format!(
            "quickpaste-recovered-image-{}.png",
            std::process::id()
        ));
        image::RgbImage::new(2, 1).save(&path).unwrap();
        let mut package =
            clipboard_formats::prepare_file_package(&[path.to_string_lossy().into_owned()])
                .unwrap();
        package.omitted_formats = vec![
            clipboard_formats::ClipboardFormatKind::Image,
            clipboard_formats::ClipboardFormatKind::Object,
        ];
        let snapshot = promote_file_image(ClipboardSnapshot::Package(package), "Weixin");
        std::fs::remove_file(path).unwrap();
        let payload = crate::snapshot_payload(snapshot, None).unwrap();
        assert_eq!(
            payload.omitted_formats,
            vec![clipboard_formats::ClipboardFormatKind::Object]
        );
    }
}
