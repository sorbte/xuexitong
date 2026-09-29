# 学习通 Edge 扩展

面向 Microsoft Edge 的学习通章节辅助扩展，支持内容类型识别、视频播放控制、PPT/PDF 自动滚动、试题页面自动跳转，以及基于 DeepSeek 的作业批改。

## 适用范围

- 浏览器：Microsoft Edge
- 扩展类型：Manifest V3 解压缩扩展
- 当前适配站点：
  - `mooc1.jjxy.zufe.edu.cn`
  - `pan-yz.chaoxing.com`
- DeepSeek API：`https://api.deepseek.com`

如果需要用于其他学校或学习通域名，需要同步修改 `manifest.json` 中的 `host_permissions` 和 `content_scripts.matches`。

## 文件结构

```text
manifest.json      扩展清单与权限
background.js      Service Worker，处理跨域文档帧和 DeepSeek 请求
content.js         页面识别、悬浮面板、视频/PPT/PDF/试题逻辑、作业批改
styles.css         悬浮面板、批改子页和答案理由样式
README.md          安装、使用和维护说明
页面特点记录.md    页面 DOM 特征及实现记录
```

## 安装

1. 打开 Edge：

```text
edge://extensions/
```

2. 打开右侧“开发人员模式”。
3. 点击“加载解压缩的扩展”。
4. 选择本项目根目录，即包含 `manifest.json` 的目录。
5. 如果 Edge 提示新增权限，确认允许以下站点：
   - 学校学习通域名
   - `pan-yz.chaoxing.com`
   - `api.deepseek.com`

修改 `manifest.json` 后，必须回到 `edge://extensions/` 点击“重新加载”，仅刷新页面不会加载新权限或新 Service Worker。

## 快速使用

1. 打开学习通章节学习页：

```text
/mycourse/studentstudy?...
```

2. 页面左下角会出现“学习通助手”悬浮框。
3. 悬浮框会自动显示当前内容类型：
   - 视频
   - PPT / PDF
   - 试题 / 作业
   - 空白页面
4. 点击“暂停自动跳转”可以统一关闭自动下一节。
5. 再次点击“恢复自动跳转”可以重新启用。

## 各页面行为

### 空白页面

- 等待 3 秒。
- 点击页面中的 `#prevNextFocusNext`。
- 倒计时期间可以在悬浮提示中取消。

### 视频页面

- 进入视频章节后自动尝试播放。
- 视频持续强制静音。
- 每 800ms 检查一次暂停状态，暂停后自动恢复播放。
- 监听 `blur`、`visibilitychange`、`mouseleave`、`pointerleave` 等事件，降低鼠标移出浏览器导致暂停的影响。
- 视频播放结束后等待 2 秒，再进入下一节。
- 如果出现未完成任务弹窗：
  1. 先关闭弹窗。
  2. 再点击页面中的“下一节”。
  3. 如果弹窗再次出现，只点击弹窗内部的“下一节”。

### PPT / PDF

- 等待真实文档帧上报稳定的 `scrollHeight/clientHeight`。
- 定位跨域 `pan-yz.chaoxing.com/screen/...` 文档帧。
- 向真实文档帧发送滚动请求。
- 每隔 2 秒滚动到底部，共执行 3 次。
- 滚动结束后再进入下一节流程。
- 如果控制台提示未收到跨域文档帧回报，请重新加载扩展并确认 `pan-yz.chaoxing.com` 权限。

### 试题 / 作业

- 识别后等待 3 秒。
- 点击页面中的 `#prevNextFocusNext`。
- 如果出现未完成任务弹窗，只在弹窗内部查找文本包含“下一节”的按钮并点击一次。
- 同一个章节只执行一次完整流程，避免循环。
- 打开“作业批改”面板时，会暂停当前试题页的自动跳转。

## DeepSeek 作业批改

### 使用步骤

1. 进入试题/作业页面。
2. 点击悬浮框中的“作业批改”。
3. 填写 DeepSeek API 密钥。
4. 选择模型：
   - `DeepSeek Pro / Reasoner`：默认，优先准确率。
   - `DeepSeek Flash / Chat`：优先速度。
5. 根据需要修改系统提示词。
6. 点击“开始批改”。

### 批改流程

- 提取题干、题型和选项。
- 不发送用户当前选择，也不发送隐藏答案字段。
- 每 5 道题调用一次 DeepSeek。
- 要求模型返回严格 JSON：

```json
{"answers":[{"id":"题目ID","answer":["A"],"reason":"不超过50个汉字"}]}
```

- 单选题和判断题只保留一个答案，并对页面选中状态做二次校验。
- 多选题会取消错误选项并补齐正确选项。
- 每道题下方会插入最多 50 个汉字的 AI 理由。

### 密钥与模型存储

- API 密钥保存在扩展的 `chrome.storage.local`。
- 密钥不会回显到输入框。
- 模型选择同样保存在 `chrome.storage.local`。
- 可以使用“清除已保存密钥”删除本地密钥。

注意：DeepSeek API 密钥会以本地扩展数据的形式保存在 Edge 配置中，请勿将 Edge 用户数据目录提交到 Git。

## 权限说明

```json
"permissions": [
  "storage",
  "scripting",
  "webNavigation"
]
```

- `storage`：保存设置、模型和 API 密钥。
- `scripting`：在真实文档帧中执行滚动探测。
- `webNavigation`：查找 PPT/PDF 的跨域文档帧。
- 内容脚本配置了 `all_frames: true`，用于处理嵌套 iframe。

## 隐私说明

- 项目不包含课程会话 Token、`enc`、`openc`、`signature` 等登录参数。
- 项目不包含硬编码的 DeepSeek API 密钥。
- 作业批改时只会向 DeepSeek 发送题目标识、题型、题干和选项。
- 不会向 DeepSeek 发送用户当前选择或页面隐藏答案。
- API 密钥只会发送到 `api.deepseek.com` 用于 API 鉴权。

## 调试与检查

语法检查：

```bash
node --check content.js
node --check background.js
```

检查 Manifest JSON：

```bash
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"
```

查看扩展日志：

1. 打开 `edge://extensions/`。
2. 找到“学习通”。
3. 点击“检查视图”。
4. 在控制台查看 `[学习通助手]` 开头的日志。

## 常见问题

### 悬浮框没有出现

- 确认扩展已在 `edge://extensions/` 中启用。
- 修改代码后点击扩展的“重新加载”。
- 刷新学习通页面。
- 确认当前域名与 `manifest.json` 匹配。

### PPT/PDF 没有滚动

- 检查 `pan-yz.chaoxing.com` 权限是否已确认。
- 在扩展控制台搜索“跨域文档帧”。
- 重新加载扩展后再刷新页面。

### DeepSeek 批改失败

- 检查 API 密钥是否正确。
- 检查 `api.deepseek.com` 权限。
- 检查模型是否可用。
- 查看悬浮框中的错误状态和控制台日志。

## 本地信息检查

提交前已检查：

- 不包含本机用户名、主机名和绝对项目路径。
- 不包含学习通登录 Token 或 URL 会话参数。
- 不包含 DeepSeek API 密钥。
- 文档中的具体课程章节 ID、题目 ID 已使用占位符或移除。
- 保留的固定域名仅用于扩展功能匹配，不包含个人数据。
