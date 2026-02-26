# CXZ_20251218_NOTE:
修改了wasdqe和移动视角逻辑，目前为和colmap对齐，采用将z轴定为竖直向上

## 手机远程位移操控落地文档

完整方案与联调步骤见 [docs/remote-control.md](docs/remote-control.md)

视图选项新增两个功能：
1.显示所有相机位置的视锥，初始保持关闭，打开即可看见
2.视角移动改为仅支持水平旋转，即只绕z轴旋转，初始保持打开，关闭之后可以自由旋转。

此外，坐标网格初始设为关闭

# CXZ_20251215_NOTE:
已经将supersplat对齐官方的2.16.1版本，playcanvas引擎也做了更新
目前支持sog格式

# CXZ_NOTE:
新增功能：
1.实现了从3dgs训练结果加载cameras.json相机位姿文件，将每一个相机位姿作为timeline上的一个关键帧，两个相邻关键帧之间相差18帧。

2.SIM按钮可以简化关键帧的选取，仅仅等比例的选取10个关键帧用于展示。

3.实现了加载原始图像的功能，右上角显示当前关键帧对应的原始图像。支持鼠标拖动、双击放大操作。

4.实现了跳转至最近关键帧相机位姿的功能，具体实现为3s的插值跳转。

5.支持WASD前后左右移动视角，QE上升/下降。

6.左侧实时计算当前视角在世界坐标系的位置和方向。

7.重写了原来supersplat轨道相机的逻辑（原来的逻辑是相机围绕目标点target做旋转来观察），现在修改为自由相机模式，通过相机的旋转矩阵转化为四元数并插值。


# SuperSplat Editor

[![Github Release](https://img.shields.io/github/v/release/playcanvas/supersplat)](https://github.com/playcanvas/supersplat/releases)
[![License](https://img.shields.io/github/license/playcanvas/supersplat)](https://github.com/playcanvas/supersplat/blob/main/LICENSE)
[![Discord](https://img.shields.io/badge/Discord-5865F2?style=flat&logo=discord&logoColor=white&color=black)](https://discord.gg/RSaMRzg)
[![Reddit](https://img.shields.io/badge/Reddit-FF4500?style=flat&logo=reddit&logoColor=white&color=black)](https://www.reddit.com/r/PlayCanvas)
[![X](https://img.shields.io/badge/X-000000?style=flat&logo=x&logoColor=white&color=black)](https://x.com/intent/follow?screen_name=playcanvas)

| [SuperSplat Editor](https://superspl.at/editor) | [User Guide](https://developer.playcanvas.com/user-manual/gaussian-splatting/editing/supersplat/) | [Blog](https://blog.playcanvas.com) | [Forum](https://forum.playcanvas.com) |

The SuperSplat Editor is a free and open source tool for inspecting, editing, optimizing and publishing 3D Gaussian Splats. It is built on web technologies and runs in the browser, so there's nothing to download or install.

A live version of this tool is available at: https://superspl.at/editor

![image](https://github.com/user-attachments/assets/b6cbb5cc-d3cc-4385-8c71-ab2807fd4fba)

To learn more about using SuperSplat, please refer to the [User Guide](https://developer.playcanvas.com/user-manual/gaussian-splatting/editing/supersplat/).

## Local Development

To initialize a local development environment for SuperSplat, ensure you have [Node.js](https://nodejs.org/) 18 or later installed. Follow these steps:

1. Clone the repository:

   ```sh
   git clone https://github.com/playcanvas/supersplat.git
   cd supersplat
   ```

2. Install dependencies:

   ```sh
   npm install
   ```

3. Build SuperSplat and start a local web server:

   ```sh
   npm run develop
   ```

4. Open a web browser tab and make sure network caching is disabled on the network tab and the other application caches are clear:

   - On Safari you can use `Cmd+Option+e` or Develop->Empty Caches.
   - On Chrome ensure the options "Update on reload" and "Bypass for network" are enabled in the Application->Service workers tab:

   <img width="846" alt="Screenshot 2025-04-25 at 16 53 37" src="https://github.com/user-attachments/assets/888bac6c-25c1-4813-b5b6-4beecf437ac9" />

5. Navigate to `http://localhost:3000`

When changes to the source are detected, SuperSplat is rebuilt automatically. Simply refresh your browser to see your changes.

## Localizing the SuperSplat Editor

The currently supported languages are available here:

https://github.com/playcanvas/supersplat/tree/main/static/locales

### Adding a New Language

1. Add a new `<locale>.json` file in the `static/locales` directory.

2. Add the locale to the list here:

   https://github.com/playcanvas/supersplat/blob/main/src/ui/localization.ts

### Testing Translations

To test your translations:

1. Run the development server:

   ```sh
   npm run develop
   ```

2. Open your browser and navigate to:

   ```
   http://localhost:3000/?lng=<locale>
   ```

   Replace `<locale>` with your language code (e.g., `fr`, `de`, `es`).

## Contributors

SuperSplat is made possible by our amazing open source community:

<a href="https://github.com/playcanvas/supersplat/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=playcanvas/supersplat" />
</a>
