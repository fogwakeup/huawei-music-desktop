# 变更记录

每条记录对照上一个提交，列出文件级与行为级变化。进度与验收视角见 [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)。

## 2026-11-21（二）— 背景图真正的根因：Chromium CSS 2²¹ 字符上限

上一条记录只修了「读取端 3 MiB / sanitize 端 4 MiB」的不一致，但那不是主因：用户清除背景后重新上传依然空白。

### 根因（实测）

- 在主进程里量出来的：`document.documentElement.style.setProperty('--x', 长字符串)`，**2,097,150 字符能写入，2,097,153 字符被静默丢弃**——不抛异常，属性直接不出现在计算样式里。Chromium 对单个 CSS 声明值的上限就是 2²¹ = 2,097,152。
- 用真实 `settings.json` 复现：里面存着 2,264,851 字符的 JPEG data URL，`--bg-image` 从未出现在 `<html>` 的 inline style 中，`.app-backdrop` 计算值是 `none`。图存进去了、界面是空的。
- 之前把非法值直接落成 `''`，所以「先清除再上传」等于把唯一能显示的机会也抹掉了，表现为怎么传都没有。

### 修复

- **新增 `src/main/image-shrink.ts`**：`shrinkBackgroundImageDataUrl()` 用 `nativeImage` 按 2560→1920→1600→1280→1024 逐级缩放并重编码；PNG 源在还能放得下时保留 PNG（保住透明通道），否则转 JPEG。
- **预算下调**：`MAX_BACKGROUND_IMAGE_DATA_URL` 从 4 MiB 改为 **1,200,000** 字符（`CSS_DECLARATION_VALUE_LIMIT = 2²¹` 之下留 ~900 KB 余量）；原始文件上限放宽到 16 MiB，因为超出部分会被压缩而不是丢弃。
- **`background-image.mjs`**：不再在读取时按 CSS 预算抛错（那会让大图直接失败），只保留原始大小上限。
- **`ipc.ts` 选图路径**：读到超预算的图先压缩再返回；压不动时用 `fail()` 返回可读原因，而不是抛异常变成「读取图片失败，请重试」。
- **`storage.ts`**：`loadSettings()` 启动时把旧配置里的超大图压缩并回写（老用户升级后立刻恢复显示，不用重新选图）；`updateSettings()` 写入口也兜一道。
- **`settings.mjs`**：`sanitizeGlass` 区分三种情况——省略字段保留原图、显式 `''`/`null` 清空、非法或超限值**保留原图**（绝不因为一次失败的上传把已有背景擦掉）。
- **`pages.tsx`**：上传失败时显示主进程返回的具体原因。

### 验证

- 新增 `scripts/test-electron-background.mjs`（并入 `glass` 套件）：用伪随机像素生成 >2 MiB 的 PNG data URL → 走真实 `settings:update` → 断言存下来的值低于上限、重启后 `--bg-image` 真的被设置且 `.app-backdrop` 绘制出 `url("data:image/...")`、`settings.json` < 1.5 MB；再断言显式清空仍然生效。
- 真实配置复现：修复前 `--bg-image` 长度 0、`settings.json` 2,265,852 B；修复后 CSS 值 462,058 字符、`settings.json` 463,051 B，截图可见背景插画。
- 单测 270/270（新增 5 项背景图/预算不变量）；Electron `glass`/`smoke`/`ui`/`taskbar`/`lyrics`/`recommend`/`favorites` 全部通过（`ui` 首轮偶发一处超时，重跑通过）。

## 2026-11-21 — 背景图替换修复、全屏让位、推荐改精准型

用户反馈三处：背景图上传不替换、播控条抢占前台导致无法全屏游戏、推荐评分与口味不符（要精准型）。

### 行为变化

- **背景图替换**（`background-image.mjs` / `settings.mjs`）：读取端原图上限 3 MiB，base64 后约 4 MiB，恰好撞上 sanitize 端 4 MiB 上限而被静默丢弃。两处改为共享常量 `MAX_BACKGROUND_IMAGE_BYTES` / `MAX_BACKGROUND_IMAGE_DATA_URL`，读取端新增按编码后长度自检，picker 接受的图保证能通过 sanitize。
- **全屏让位**（`mini-player.ts` / `mini-player-layout.mjs` / `desktop-lyrics.ts`）：置顶级别 `screen-saver` → `floating`（不再凌驾于全屏游戏之上）；新增纯函数 `isFullscreenBand()`，心跳（1.5s）检测到全屏工作区时隐藏播控条、退出后恢复；桌面歌词窗同样降为 `floating`。
- **推荐改精准型**（`recommend.mjs`）：歌手/专辑重回评分且为最高权重（.34/.12）；排序从 `|score-target|` 改为**降序**（修正「99 分被 78 分盖过」的逻辑错误）；新增收藏样本推导的契合线 `floor`，低于它直接过滤；多样性靠每歌手/每专辑配额（1→2→3→不限）而非负分；界面文案改「口味契合线 / 按口味契合度从高到低」。

### 测试

- 背景图新增「满额图必经 sanitize」回归；播控条新增 `isFullscreenBand` 用例；推荐 28 项单测覆盖契合线、降序、低契合过滤、歌手专辑加分。
- 验证：typecheck、离线单测 **268/268**、Electron glass / taskbar / lyrics / recommend 全绿。

## 2026-11-18（二）— 推荐改为「歌曲评分 + 相似评分匹配」

主题：用户反馈上一版仍困在同歌手/同专辑循环。评分从「候选对画像的亲和度」改成「歌曲自身的内容分」，歌手/专辑身份从最大加分项变成减分项，同时打开三路新候选源。

规模：3 个源码文件 + 2 个测试/脚本；离线单测 257 → **266** 项。

### 行为变化

- **评分重定义**（`SCORE_WEIGHTS`）：语种 0.32 / 版本 0.18 / 时长 0.20 / 主题用词 0.20 / 歌单共现 0.10，权重和为 1，`scoreSong` 返回 0–100 分与各分项；**不再包含歌手与专辑**。旧 `scoreCandidate` 保留为 0–1 标度的别名。
- **排序重定义**（`buildScoreProfile` + `scoreSimilarity`）：目标分与容忍带来自收藏样本，`rankCandidates` 按「与目标分的距离」排序；同收藏歌手减 0.10、同收藏专辑减 0.06；渐进配额从 **1 首/歌手、1 首/专辑**起步（原来是 2/3/5）。
- **新主题维度**：`titleTokens` / `buildThemeTokens` 从收藏歌名提取 recurring 中文二字词与英文词，过滤「我们/一个」这类通用词；`buildSearchKeywords` 用真实版本词 + 高频主题词去搜索接口取开放曲库。
- **候选源七路**：原同歌手、同专辑、歌单未收藏曲目，加上二跳歌手/专辑（歌单与历史里出现但没直接收藏过的）、主题搜索、榜单歌单（`kind === 'chart'`）。
- **界面**：评分画像行显示目标分、主题词、语种、时长、版本；每行副标题显示「评分 NN · 语种 … · 主题…」；顶栏副标题改为「按歌曲评分寻找相近口味，主动避开同歌手与同专辑循环」。
- **二跳排除集修正**：只排除**直接收藏**的歌手/专辑，而不是整个画像，否则歌单/历史里的歌手会被全部排除、二跳源永远为空。

### 测试

- 单测新增/改写 28 项：评分不含歌手专辑、陌生歌手可高分、0–100 与旧 0–1 标度、主题词提取与停用词、目标分与容忍带、评分相近优先于同歌手、同分时的重叠惩罚、逐歌手/逐专辑首轮限 1、二跳排除、`buildSearchKeywords` 去重。
- Electron 推荐页回归改为验证七路来源、目标评分文案、每行评分与 32 首候选分页；smoke / ui / business / favorites 回归全绿。

## 2026-11-18 — 推荐算法改为五维打分

主题：猜你喜欢从「同歌手 + 同专辑轮转」升级为五维加权打分，并补齐曲风近似的三维信号。

规模：4 个源码文件 + 2 个测试/脚本，+560 / −120 行；离线单测 245 → **257** 项。

### 行为变化

- **口味画像**从「歌手/专辑频次」扩到六项：`artists`、`albums`、`languages`（华语/日语/韩语/英语，按标题与艺人名的文字判定）、`versions`（Live/Remix/伴奏/翻唱/不插电/小样）、`duration`（加权均值/标准差/极值）、`total`（加权样本量）。
- **样本分层**：收藏歌曲权重 1.0、收藏歌单曲目 0.7、最近播放 0.5；`buildTasteProfile` 接受裸曲目或 `{track, weight}` 两种输入，计数可为小数。
- **五维 + 一维打法**：`DIMENSION_WEIGHTS` 歌手 0.34 / 专辑 0.14 / 收藏歌单共现 0.20 / 语种 0.16 / 时长习惯 0.10 / 版本类型 0.06，权重和为 1，`scoreCandidate` 返回分数与可读理由。
- **候选来源三路**：歌手详情、专辑详情、收藏歌单里未被收藏的曲目（同一首歌出现在多个歌单则加权）。
- **排名与多样性**：`rankCandidates` 先按分排序，再做渐进式歌手配额 2 → 3 → 5 → 不限，最后才放开，避免首屏被单一歌手占满；`buildRecommendationPool` 传 `model` 时走打分路径，不传时保留原轮转语义（旧单测不变）。
- **界面**：英雄区新增「画像」一行（语种占比、平均时长、常见版本），每行标题下新增 `track-why` 推荐理由；`TrackTable` 增加可选 `subtitleOf`，其它页面不受影响。

### 测试

| 文件 | 变化 |
|---|---|
| `test/recommend.test.mjs` | 6 → 19 项：语种判定、版本标记、加权画像、维度权重归一、单曲打分（强/弱对比）、版本惩罚、多样性配额、排除/去重/不可播、limit 兜底、`formatClock` |
| `scripts/test-electron-recommend.mjs` | 夹具补时长与历史；改为等待摘要出现（原先靠抢先读取，加接口后必失败）；新增画像行与 `track-why` 断言 |

### 已知边界

- 曲风无接口来源（`docs/API_CONTRACT.md` §5 无曲风/标签字段），因此用 语种 + 版本 + 时长 三束信号近似，UI 与文档都不宣称是真实曲风分类。
- 粤语与国语文字上不可区分，统一记作华语。

## 2026-11-17 — `8fea9a5` + 本轮（对比 `f8091a7`）

主题：曲目右键菜单、桌面播控条（后续改为嵌入任务栏）、桌面歌词可调、毛玻璃主题与背景自定义、猜你喜欢推荐页。
规模：两个阶段共 64 个文件次，+3300 / −390 行；离线单测 205 → **245** 项。

### 新增文件

| 文件 | 内容 |
|---|---|
| `src/renderer/recommend.mjs` / `recommend-page.tsx` | 本地推荐算法（口味画像、轮转池、分批）与「猜你喜欢」页 |
| `src/main/lyrics-layout.mjs` + `test/lyrics-layout.test.mjs` | 歌词窗尺寸/贴边/面板生长/底边固定的纯几何逻辑 |
| `src/main/background-image.mjs` + `test/background-image.test.mjs` | 背景图读入：扩展名白名单、≤3 MB、严格 `data:` URL（拒 SVG） |
| `scripts/test-electron-taskbar.mjs` / `-lyrics.mjs` / `-glass.mjs` | 任务栏播控条、歌词窗、毛玻璃三套 Electron 端到端断言 |
| `test/recommend.test.mjs` / `test/remove-from-queue.test.mjs` | 推荐交错与「移出队列」行为 |

### 曲目右键菜单

- 行级右键菜单（`src/renderer/components.tsx`）：播放 / 下一首播放 / 收藏 / 移出队列 / 从历史移除，按上下文裁剪菜单项。
- 与既有行内按钮共用同一 IPC 通道，状态与收藏页、播放队列实时同步。

### 桌面播控条 → 嵌入任务栏

- `src/main/mini-player-layout.mjs` 新增 `taskbarStrip(bounds, workArea)`（推导任务栏四边与厚度，自动隐藏回退 48px）与 `taskbarBarRect()`（条入带内、横向钳制、托盘预留）。
- `src/main/mini-player.ts` 重写：任务栏形态下 `move` 事件持续钉住竖轴、`moved` 落盘 `taskbarX`；显示器/工作区变化重算；5 秒置顶心跳；关闭按钮改为最小化到托盘。
- 拖动改为 `drag-start/move/end` IPC：`focusable:false` 窗口收不到原生拖拽，改由渲染层报位移、主进程按 `screen.getCursorScreenPoint()` 跟随（同一套也用于歌词窗）。

### 桌面歌词可调

- 字号 16–96、宽度 280–2400、颜色（预设 + 取色器）、可选深色底板；窗口高度随字号推导，改字号时底边固定不漂移。
- 默认纯文字**无底板**，样式/控制条仅悬停显示；锁定后 `display:none` + 鼠标穿透，黑框与面板一并消失。
- 设置页与歌词窗双向同步：新增 `settings:changed` 广播，窗内改样式后主窗设置页立即刷新。

### 毛玻璃主题与背景自定义

- 全窗（含标题栏、侧栏）改为同一层毛玻璃；`GlassSettings` 暴露模糊/底色/不透明度/饱和度/圆角/描边/投影共 9 项 + 背景图。
- 背景图经原生选择器读入主进程净化后转 `data:` URL 存设置，铺在最底层；修复「上传后背景不变」与设置页上滑重叠。
- `sanitizeGlass` 对颜色做 HEX 白名单、数值全钳制，坏补丁不致整份设置被判损坏。

### 猜你喜欢

- 收藏歌曲 + 收藏歌单作种子建口味画像，取同歌手/同专辑候选，按频次轮转交错、剔除已收藏与无版权曲，分批 + 换一批。
- 服务端每日推荐接口对公开请求形态一律 400，故全部在本地计算，不伪造服务端推荐。

### 测试

离线单测 245/245；`test:electron` smoke / ui / business / favorites / recommend / glass / taskbar / lyrics / callback / cancel / storage 全部通过；typecheck 通过。

## 2026-10-28 — `4fac4c9`（对比 `71d9213`）

主题：按曲音质档位切换、搜索页播放全部、会话过期感知与 refresh_token 留存。
规模：25 个文件，+494 / −73 行（其中测试 +145 行）。

### 新增文件

| 文件 | 内容 |
|---|---|
| `src/shared/qualities.mjs` + `.d.mts` | 音质档位纯逻辑：`QUALITY_ORDER` / `QUALITY_CODES` / `QUALITY_LABELS`、qualityType(1/2/3/7) 与档位互转、`fallbackQuality` 回退 |
| `src/shared/session-expiry.mjs` + `.d.mts` | 14 位 `expireTime`（yyyyMMddHHmmss）解析与过期判定；UTC/本地双解释取较晚者，晚判不误报；不可能日期经重建 round-trip 校验判 null |
| `test/qualities.test.mjs` | 档位互转与回退 4 项断言 |
| `test/session-expiry.test.mjs` | 双解释上界、过期判定、非法输入 3 项断言（时区无关） |

### 音质档位（用户可感知行为变化）

- 列表/详情解析 `contentExInfo.completeFileInfos`（`src/main/library.mjs` +35），`Track.qualities` 只暴露 标准(1)/HQ(2)/无损(3) 三档；**超清(7) 撤下**——超钻会员实测被服务端以 resultCode 142411 拒绝，属设备链路限制，不归因会员等级。
- 播放坞新增档位弹出菜单（`src/renderer/components.tsx` +42），当前档打勾；切换**立即换流并保留播放进度**（`src/renderer/App.tsx` `changeQuality`）。
- 请求档不可用时自动回退：先向低找最高，再向高找最低（只有更高档的歌也能播，并提示实际档位）。
- 设置页新增默认音质下拉（`pages.tsx`、`settings.mjs` `QUALITIES`/`sanitizeQualities`）；队列持久化保留每曲档位（`sanitizeTrack` 条件附加，无值不加键）。
- 播放实际档确认改为以响应 `playQuality` 数字为准（`track-quality.mjs` 重写 99%）；旧 `confirmedPlaybackQuality` 的 `type` 字段 MIME 交叉假设被真实样本推翻（`type:"1"` 是枚举）。
- `src/music.mjs` / `ipc.ts` / `auth-manager.ts` / `huawei.ts`：resolvePlayback 链路改传档位码，IPC 白名单与签名同步（`Playback.actualQuality: Quality | 'unknown'`）。

### 搜索页播放全部

- 有更多分页时按钮显示「播放已加载 N 首」，只播已加载且无版权过滤后的曲目，不宣称播全量结果（`pages.tsx`）。

### 会话过期感知与 refresh_token 留存（无自动续期）

- `openLogin`（`huawei.ts`）保留 offline 授权响应中的 `refresh_token`，持久化到 `session.enc` 的 `oauth.refreshToken`（`storage.ts` 类型、`session-store.cjs` 载入时归一为可信形状，其余形状丢弃）；logout 一并清除。**仅留存，登录流程不使用**——公开客户端 refresh grant 已于 2026-10-14 实测被拒（1101/20171，见 [token-lifetimes-and-renewal.md](token-lifetimes-and-renewal.md)），7 天后用真实凭据复测。
- 音乐请求被服务端拒绝（ProviderError）且字面已过期时，错误文案统一为「音乐登录已过期，请重新扫码登录。」（`code: session-expired`，`auth-manager.ts` +39 中含 `#expiredFailure`）；仅网络错误或未过期时保持原结构化错误。
- 收藏与歌单/专辑在此场景回退本地缓存（与既有网络失败回退同机制）。
- 侧栏状态点亮橙显示「音乐登录已过期」（`App.tsx`、`styles.css` `.status-dot.expired`）；右上角「重新登录」按钮原有。

### 测试

| 文件 | 变化 |
|---|---|
| `test/library.test.mjs` +38 | completeFileInfos 两种形态解析、三档暴露（不含 ultra） |
| `test/settings.test.mjs` +31 | 默认音质档位、队列 qualities 保留 |
| `test/playback-quality.test.mjs` 重写 83% | 以 playQuality 数字为准的确认逻辑 |
| `test/session-store.test.mjs` +21 | oauth 往返与归一（垃圾字段丢弃、坏形状删键） |
| `test/qualities.test.mjs` / `test/session-expiry.test.mjs` | 新文件 |

离线单测 201 → **205** 项；`test:electron` / `test:electron-ui` / `test:electron-business` 全部通过。

### 实测结论（本轮新增的契约事实）

- qualityType 7 在超钻账号 + HTTP 200 下返回 resultCode `142411`：超高清 2.0 需要 HarmonyOS NEXT 设备 + 华为耳机 L2HC 全链路，且该档在 completeFileInfos 无 fileSize（设备端动态处理流），桌面端不暴露。
- `auditionTime` 在会员完整播放时同样出现，继续不作为试听判据。
