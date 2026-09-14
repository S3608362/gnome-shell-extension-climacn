# ClimaCN - 中国天气 GNOME Shell 扩展

![License](https://img.shields.io/github/license/S3608362/gnome-shell-extension-climacn)
![Top Language](https://img.shields.io/github/languages/top/S3608362/gnome-shell-extension-climacn)
![GitHub Release](https://img.shields.io/github/v/release/S3608362/gnome-shell-extension-climacn)

**国内 GNOME 用户一直缺少一个精准的天气扩展。**  
ClimaCN 基于和风天气 API，内置全国城市数据库，支持自定义 API Host，图标完美适配深色顶栏。

## ✨ 功能特性

- 🏙️ 内置全国城市数据库，支持汉字搜索
- 🌡️ 实时温度、体感温度、湿度、风向风力
- 📊 气压、能见度、露点、云量、紫外线指数、阵风、降水量
- 📅 未来三天逐日预报（最高/最低温度、天气状况）
- ⚙️ 支持自定义 API Key 和 API Host
- 🎨 图标自动适配 GNOME 深色顶栏
- 🔄 每 15 分钟自动刷新

## 📦 安装方法

### 安装

1. 下载 [最新版本](https://github.com/S3608362/gnome-shell-extension-climacn/releases/latest) 的 `.shell-extension.zip`

2. 解压到扩展目录：

   ```bash
   mkdir -p ~/.local/share/gnome-shell/extensions/climacn@outlook.com
   unzip -o climacn@outlook.com.shell-extension.zip \
     -d ~/.local/share/gnome-shell/extensions/climacn@outlook.com
   ```

3. 编译 Schema：

   ```bash
   glib-compile-schemas \
     ~/.local/share/gnome-shell/extensions/climacn@outlook.com/schemas/
   ```

4. 重启 GNOME Shell：

   - **X11**：按 `Alt+F2`，输入 `r`，回车
   - **Wayland**（多数发行版的默认会话）：注销后重新登录

5. 打开「扩展」应用，启用 ClimaCN

### 配置

点击扩展的齿轮图标打开首选项，填写两项。两项均可在[和风天气控制台](https://console.qweather.com/)获取：

| 项 | 位置 |
| --- | --- |
| **API Key** | 控制台 → 项目管理 → 凭据 |
| **API Host** | 控制台 → 设置，形如 `abcxyz.qweatherapi.com`，**不要**写 `https://` |

> ⚠️ 自 v1.3 起 **API Host 为必填**。和风天气的公共 API 地址（`devapi.qweather.com` 等）
> 自 2026 年起逐步停止服务，扩展已迁移到新版 v1 接口。

## 常见问题

**Q：图标全是黑色？**
A：确保图标文件以 `-symbolic.svg` 结尾，GNOME 会自动适配。

**Q：填了凭据但获取失败？**
A：依次检查：① API Host 是否填的是自己账号的地址（不是 `devapi.qweather.com`）；
② API Key 是否有效；③ 该凭据是否开启了 API 限制但未包含天气接口。
按 `journalctl -f -o cat /usr/bin/gnome-shell` 可以看到具体的 HTTP 状态码。

**Q：菜单显示「上次更新」是什么时间？**
A：是最近一次成功获取到数据的时间（手动刷新和自动刷新都会更新它）。
和风天气的实时接口不返回观测时间，所以这里显示的是扩展拉取数据的时间。

**Q：改了 API Key 或 Host 之后没反应？**
A：保存后约 1 秒会自动重新拉取，不需要重载扩展。

## 🖼️ 图标版权

天气图标来源于 [和风天气图标库](https://icons.qweather.com/)，采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 许可。

天气数据由[和风天气](https://www.qweather.com/)提供，归因说明见
<https://developer.qweather.com/attribution.html>。

## 📄 开源协议

GPL-2.0-or-later
