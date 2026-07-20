# QuickPaste 真实机验收脚手架

这里保存可重复的验收协议、临时 profile 启动器和机器可读 schema，不保存任何一次运行的数据库、日志、账本或截图。脚手架本身的测试属于 **automated proof**；10k 历史基准属于 **synthetic benchmark**；下列四项在完成独立 Windows 运行并生成有效结果前一律标记为 **pending real-machine**。

| 场景 | 固定规模 | 判定 | 当前自动化边界 |
| --- | --- | --- | --- |
| `warm-first-frame` | 50 次预热 + 500 次采样 | nearest-rank p95 ≤ 120 ms | 应用生成本地 metrics；真实快捷键循环需要外部驱动或人工操作 |
| `paste-ordinary` | 10,000 次 | 独立目标验证成功率 ≥ 99.5% | 必须使用 external ordinary-integrity target，仓库不以内部 `pasted` 状态代替 |
| `capture-ledger` | 100,000 次 | 缺失 + 额外 + 重复 + 自身回流严格 < 0.1% | 必须使用 independent writer/expected-ID ledger 并对账 DB 与事件计数 |
| `dpi-mixed` | 1.0、1.25、1.5、1.75、2.0、2.25、2.5 | 所有检查通过 | Windows 缩放、显示器摆放和任务栏位置必须人工调整 |

脚手架 never uses the live user database：启动器只会把系统临时目录的直接子目录 `QuickPasteAcceptance/<run-id>` 作为隔离 profile 和 RunRoot；该 canonical 直接子目录边界与原生 fail-closed 校验一致。它要求显式 `-OptIn`，发现已有 QuickPaste 进程时会拒绝启动，并同时传入 `--acceptance-metrics` 与 `QUICKPASTE_ACCEPTANCE_PROFILE`；只有 flag 没有该 profile 环境变量时，候选也会在 Tauri setup 前拒绝启动，绝不回落真实 app-data。WebView2 用户数据通过 `WEBVIEW2_USER_DATA_FOLDER` 指向 `RunRoot/WebView2`。候选必须先在 profile 根创建只含版本与 UTC 时间的 `acceptance-profile-v1.json` marker，启动器才会返回；二进制不含契约字面量、marker 超时或字段异常时都会 fail closed。不要以管理员身份运行这些命令。

## 先验证脚手架

在仓库根目录运行：

```powershell
node --test scripts/acceptance/acceptance.test.mjs
```

该测试只创建和删除系统临时目录，不启动 QuickPaste，不改写剪贴板，不执行 10,000/100,000 次循环，也不修改 Windows 显示设置。

## 为单个场景创建隔离运行

先正常退出所有 QuickPaste 实例，再使用本次 Release 候选 `quickpaste.exe`：

```powershell
pwsh -NoProfile -File scripts/acceptance/Invoke-Acceptance.ps1 `
  -Scenario warm-first-frame `
  -CandidateExecutable '<candidate>quickpaste.exe' `
  -OptIn
```

`-Scenario` 可替换为表中的另外三个值。命令会输出 `RunRoot`、`ResultPath`、`ProfileRoot`、marker/metrics 路径和进程 ID。每个场景必须新建一次运行，不能复用真实 profile，也不能把一个场景的计数挪给另一个场景。仅修改 `APPDATA`/`LOCALAPPDATA` 不能重定向 Tauri 在 Windows 上使用的 Known Folder，因此绝不能绕过专用 `QUICKPASTE_ACCEPTANCE_PROFILE` 契约直接启动旧候选。

本地 metrics 固定使用 app-data 相对路径 `acceptance/metrics-v1.json`，完整字段白名单见 [metrics-v1.schema.json](metrics-v1.schema.json)。粘贴闭集以 `clipboardWriteFailed` 记录剪贴板写入失败终态，保证每次命令的早退也可对账。生产默认模式不应生成该文件；验收模式的文件只含 UTC 时间、非负耗时数组和闭集计数，不含正文、长度、来源应用、路径、错误、哈希或剪贴板序列。

## 50 + 500 暖唤起

1. 使用 `warm-first-frame` 新 profile 启动 Release 候选；确认测试 profile 内出现且只出现一个 `acceptance/metrics-v1.json`。若生产方式启动也出现该文件，立即判失败。
2. 在普通权限的空白文本目标中进行 50 个预热循环。一个循环必须是：目标获得焦点 → 真实全局快捷键显示快速面板 → 等待面板可交互 → `Escape` 隐藏。面板已显示时再次按快捷键只是隐藏，不算一个 show sample。
3. 用相同流程再完成 500 个采样循环。外部按键驱动可以减少人工操作，但必须逐次等待显示/隐藏完成，并独立记录恰好 550 个成功循环；丢步、焦点漂移或重复触发时废弃本次运行并使用新 profile 重来。
4. 应用只保留最新 500 个样本，因此完成 550 个有效循环后，metrics 数组必须恰好有 500 项。用以下命令验证白名单并按 `sorted[ceil(0.95*n)-1]` 计算 p95：

   ```powershell
   node scripts/acceptance/acceptance.mjs validate-metrics --file '<metrics-v1.json>'
   ```

5. 把输出的样本数和 p95、metrics 文件 SHA-256 写入 `result.json`。`p95Ms <= 120` 才是通过；该指标名称只能写“frontend first-frame acknowledgement”，不能写成合成器实际呈现时间。

## 10,000 次普通目标粘贴

仓库没有足够可靠的 Win32 焦点/SendInput 驱动可在所有验收机上无监督执行此循环，因此没有 helper 时必须保持 **pending real-machine**，不能用单元测试、内部 `PasteResult.pasted` 或 paste counters 填成通过。

独立 helper 必须满足以下协议：

1. helper 是与 QuickPaste 分离的普通完整性 Windows 进程，目标为可读取实际内容的原生可编辑控件；不得提升权限，不得链接或调用 QuickPaste 内部代码。
2. 使用新的 `paste-ordinary` 临时 profile。每次尝试生成唯一合成 ID，先由外部写入器放入剪贴板并等待 QuickPaste 捕获，再重新聚焦 helper 控件，通过真实全局快捷键和 `Enter` 触发默认粘贴。
3. helper 从目标控件读取实际收到的内容，与本次期望 ID 做完全相等比较，并把每个 ordinal 恰好写入一次外部账本。超时、错目标、空值和内容不一致都计失败，不能重试后抹掉第一次终态。
4. 连续完成 10,000 次；账本必须满足 `success + failed = 10000`。对账后记录账本 SHA-256，只把计数和摘要写入 `result.json`，运行账本本身留在临时目录且不得提交。
5. 成功数至少 9,950 才通过；9,949 必须失败。内部计数只能作为诊断，不是目标实际收到内容的证据。

## 100,000 次外部写入与账本对账

同样，没有能满足所有机器剪贴板时序和 SQLite 保留策略的独立 writer/reconciler 时，本项保持 **pending real-machine**。

1. 使用新的 `capture-ledger` 临时 profile，暂停和排除列表关闭，保留期设为永久，普通历史容量至少为 100,000。若候选构建无法在测试 profile 中设置该容量，停止并记录 pending，不能在会裁剪的 500/10k 数据库上推断通过。
2. 启动一个与 QuickPaste 分离的普通权限 writer。writer 依次写入 100,000 个唯一编号合成 ID；只有 Windows 剪贴板写入成功并回读一致后才把 ordinal/expected ID 写入 expected-ID ledger。不要混入真实剪贴板内容。
3. 写入结束后等待捕获队列清空并正常退出候选程序。对临时 `history.sqlite3` 中本次 run ID 的行与 expected-ID ledger 做集合和频次对账，分别得到 `databaseMatched`、`missingWrites`、`unexpectedRecords`、`duplicateRecords` 和 `internalWritesRecorded`。
4. 同时读取同一 profile 的 metrics，要求 `eventDelivered + eventFailed = completedWrites`，并把 `stableExternal`、`internalWriteConsumed` 等计数作为诊断交叉检查；内部 counters 不能单独证明捕获完整性。
5. 计算 `discrepancyCount = missingWrites + unexpectedRecords + duplicateRecords + internalWritesRecorded`，再算 `discrepancyRatePercent = discrepancyCount / 100000 * 100`。99 个异常为 0.099%，通过；100 个为 0.1%，必须失败。
6. 记录 writer ledger、DB 对账导出和 metrics snapshot 的 SHA-256；原始 DB、账本、导出和日志仍只留在临时目录，不得提交。

## 1.0–2.5 混合 DPI 检查

Windows 显示缩放切换可能重排桌面、要求注销并影响其他程序，脚手架不会自动更改系统设置。请使用 `dpi-mixed` 临时 profile 和仅含合成内容的历史，逐项填写 `result.checks`：

1. 覆盖七个比例 1.0/1.25/1.5/1.75/2.0/2.25/2.5，每个比例至少一次；至少一次让两个显示器同时使用不同缩放。
2. 把一个副屏放到主屏左侧或上方以产生负坐标，并再覆盖正坐标副屏。分别从鼠标锚点与文本插入点唤起，包含光标和锚点跨显示器的情况。
3. 在整个矩阵中把任务栏依次放到 left/right/top/bottom；每个边缘都在靠近工作区四角的位置唤起。
4. 每行记录 `scaleFactor`、`monitorPlacement`、`taskbarEdge`，并确认面板四个角全部位于选中显示器工作区且使用了锚点所在显示器。任何裁切、错屏或定位错误都填 `fail`。
5. 截图如确有必要，只能放在本次 `RunRoot/evidence` 并使用合成内容；不得放入仓库。

## 校验结果且不伪造证据

[acceptance-result.schema.json](acceptance-result.schema.json) 只容许四种场景的固定字段。先做 JSON Schema 检查，再做阈值和对账算术检查：

```powershell
Test-Json -LiteralPath '<run-root>\result.json' `
  -SchemaFile 'scripts\acceptance\acceptance-result.schema.json'
node scripts/acceptance/acceptance.mjs validate-result --file '<run-root>\result.json'
```

只有完整真实机运行才能把 `evidenceClass` 改为 `real-machine` 并把 `status` 改为 `pass` 或 `fail`。未运行、样本不足、helper 不独立、profile 可能污染、账本缺失或 DPI 矩阵不完整时，保留 `pending-real-machine`/`pending`（中止的真实运行可记为 `real-machine`/`aborted`）。

核验后关闭候选进程。需要保留调试证据时只保留在系统临时目录并标记 `preserved-for-debug`；否则删除整个 `RunRoot`。不要提交 `result.json`、metrics、数据库、日志、账本或截图。
