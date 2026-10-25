# Third-Party Notices

0.2.0分发工具使用`scripts/collect-licenses.py`从已安装npm/Python、当前Rust目标依赖和CPython运行时生成`DEPENDENCY-NOTICES.md`与`license-review.json`。`third-party/license-sources.json`保存缺失上游文本/概述的版本、URL和SHA-256。概述不冒充完整许可文本；生成清单不宣称覆盖二进制内所有嵌套原生依赖。分发前仍核对MPL等许可证的来源提供要求，锁定版本源码可从上游仓库/包注册表取得。

项目原创代码采用MIT；第三方依赖不因本项目许可证而改变许可。本文件补充本轮新增的直接运行依赖，不是所有npm/Cargo/Python传递依赖的完整清单；锁文件记录实际版本，分发者仍应保留各依赖许可。

## react-markdown 10.1.0

来源：https://github.com/remarkjs/react-markdown

The MIT License (MIT)

Copyright (c) Espen Hovlandsdal

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


## remark-gfm 4.0.1

来源：https://github.com/remarkjs/remark-gfm

(The MIT License)

Copyright (c) Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## 0.2.1 分发补充

`third-party/license-sources.json`保存按包名和锁定版本匹配的上游来源、标准许可文本、作者归属及SHA-256。objc2系列保留上游许可概述，并另附MIT标准条款及Cargo元数据中的作者；多许可包本次选择MIT。selectors补附MPL-2.0标准条款。标准文本中的占位署名不是新增版权归属，具体归属以原始包源码与原有声明为准。许可原文不翻译，避免改变条款含义。

发行包的`notices/DEPENDENCY-NOTICES.md`收集原始声明，`notices/SOURCE-LOCATIONS.md`列出锁定版本的上游源码位置。本轮收集器的缺失许可文本清单为零，表示已补齐其发现的文本缺口，不代表完整法律审计或自动确认一切再分发义务。
