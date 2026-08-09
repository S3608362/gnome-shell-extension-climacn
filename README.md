# ClimaCN - 中国天气 GNOME Shell 扩展

![License](https://img.shields.io/github/license/S3608362/gnome-shell-extension-climacn)
![Top Language](https://img.shields.io/github/languages/top/S3608362/gnome-shell-extension-climacn)

**国内 GNOME 用户一直缺少一个精准的天气扩展。**  
ClimaCN 基于和风天气 API，内置全国城市数据库，支持自定义 API 地址，图标完美适配深色顶栏。

## ✨ 功能特性
- 🏙️ 内置全国城市数据库，支持汉字搜索
- ⚙️ 支持自定义 API Key 和 API 地址
- 🎨 图标自动适配 GNOME 深色顶栏
- ⏱️ 实时显示温度、体感温度、湿度、风向风力

## 📦 安装方法
1. 下载本仓库代码，解压到：
   ```
   ~/.local/share/gnome-shell/extensions/climacn@outlook.com/
   ```
2. 编译 Schema：
   ```
   glib-compile-schemas schemas/
   ```
3. 重启 GNOME Shell（按 `Alt+F2`，输入 `r`，回车）
4. 打开“扩展”应用，启用 ClimaCN，点击齿轮图标配置你的 API Key 和 API 地址

## 🔑 获取 API Key
前往 [和风天气开发版](https://dev.qweather.com/) 注册免费账号即可获取。

## 常见问题

Q: 图标全是黑色？
A: 确保图标文件以 -symbolic.svg 结尾，GNOME 会自动适配。

Q: API Key 填了但获取失败？
A: 检查 API 地址是否正确（默认 https://devapi.qweather.com），并确认 API Key 有效。

## 🖼️ 图标版权
天气图标来源于 [和风天气图标库](https://icons.qweather.com/)，采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 许可。

## 📄 开源协议
GPL-2.0-or-later
