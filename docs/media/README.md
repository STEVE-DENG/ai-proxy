# 图形资源与来源

本目录图片不包含真实用户流量、供应商信息或密钥。生成模式为内置`image_gen`，未使用CLI或项目Provider密钥。概念图不是产品运行截图，不能作为功能验收证据。

- `app-icon-source.png`：最终生成的透明外角图标原图。macOS图标通过已安装的Tauri CLI生成`src-tauri/icons/`资源；应用内部使用256px导出版`public/brand/app-icon.png`，避免载入完整大图。
- `workflow-illustration.png`：README概念配图，展示手机/本机→本地采集→请求与证据，不表示真实连接成功。
- `architecture.svg`：按当前React/Tauri/Python源码人工绘制的数据与权限边界图。

## 图标生成提示词

```text
Use case: logo-brand. Asset type: replacement macOS desktop app icon for AI Proxy, a local network capture and AI debugging workbench. Primary request: a beautifully restrained, legible macOS application icon that feels at home next to professional developer tools, works on both light and dark desktops. Composition: ONE square icon only, not a presentation sheet or mockup. Full-bleed deep forest green softly rounded macOS tile with a clean warm ivory symbol: two parallel routed network lines smoothly passing through a central rounded capture window, a tiny warm copper packet node at one end. Geometric, simple silhouette readable at 32 pixels. Subtle dimensional edge and soft light, almost flat, premium tactile enamel. Centered with generous optical padding. No text, letters, robot, sparkles, AI brain, watermark, UI, or extra objects. Output a square high resolution icon artwork.
```

## 透明外角编辑提示词

输入为上一张图标，使用`transparent_background=true`：

```text
Use case: background-extraction. Edit target: the supplied AI Proxy application icon. Make ONLY the four outside corner regions around the rounded green tile transparent, with crisp alpha edges, including removal of the external drop shadow. Keep the forest green rounded square tile, ivory routed network lines, copper packet node, interior lighting, layout and all proportions exactly unchanged. The tile should have a generous transparent canvas margin of approximately 6% on every edge, as a finished macOS icon asset. No added objects or text.
```

## README概念图提示词

```text
Use case: ads-marketing. Asset type: wide 3:1 open-source README illustration for AI Proxy, a local HTTP(S) capture and AI debugging desktop workbench. Primary request: a precise and restrained editorial technical illustration of a request traveling from a smartphone and desktop, through a central forest-green local capture instrument, into a small row of organized request records and an evidence document. Simple ivory surfaces, forest green outlines and a small copper packet node, on a clean neutral light background. Strong geometry, horizontal left-to-right flow, generous negative space, carefully spaced diagram-like objects. Include subtle dark-green panel within the capture instrument so it harmonizes with both the light and dark UI. No words, letters, numbers, logos, robot, brain, chat bubbles, watermark, photographic screens or fake screenshots. This is a conceptual product illustration, not a screenshot or a claim that a real connection succeeded.
```

## 0.2.1 图标更新

按用户最新要求，当前应用图标**不含中文或其他文字**。颜色改为浅薄荷绿底、柔和玉绿色网络符号和浅桃色节点，透明外角保留。使用内置`image_gen`编辑原图；旧深绿与带文字候选均不用于0.2.1。`app-icon-source.png`和应用、macOS图标资源同步更新；架构SVG所有说明改为中文。

当前图标编辑要求：保持原网络路由与抓包窗口符号，背景改为浅薄荷绿（参考`#DCEDE5`、`#B9D8CA`），符号为柔和玉绿（`#4D8672`），节点为浅桃色（`#E3B79D`）；不添加文字、字母、数字或新物体，清理圆角方块外的杂点并保留真实透明像素。仅改变图标，示意插图仍为概念图，不作为运行截图。
