import { ApiError } from "@/models/errors";
import { NextRequest, NextResponse } from "next/server";
import puppeteer, { Browser, ElementHandle, Page } from "puppeteer";
import {
  ElementAttributes,
  SlideAttributesResult,
} from "@/types/element_attibutes";
import { convertElementAttributesToPptxSlides } from "@/utils/pptx_models_utils";
import { PptxPresentationModel } from "@/types/pptx_models";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import sharp from "sharp";

interface GetAllChildElementsAttributesArgs {
  element: ElementHandle<Element>;
  rootRect?: {
    left: number;
    top: number;
    width: number;
    height: number;
  } | null;
  depth?: number;
  inheritedFont?: ElementAttributes["font"];
  inheritedBackground?: ElementAttributes["background"];
  inheritedBorderRadius?: number[];
  inheritedZIndex?: number;
  inheritedOpacity?: number;
  screenshotsDir: string;
}

export async function GET(request: NextRequest) {
  const startTime = Date.now();
  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    console.log(`[PPTX] 开始处理请求`);

    const id = await getPresentationId(request);
    console.log(`[PPTX] 演示ID: ${id}`);

    // 关键步骤1：启动浏览器并加载页面
    const t1 = Date.now();
    [browser, page] = await getBrowserAndPage(id);
    console.log(`[PPTX] 浏览器+页面加载耗时: ${Date.now() - t1}ms`);

    const screenshotsDir = getScreenshotsDir();

    // 关键步骤2：获取幻灯片
    const t2 = Date.now();
    const { slides, speakerNotes } = await getSlidesAndSpeakerNotes(page);
    console.log(`[PPTX] 获取${slides.length}张幻灯片耗时: ${Date.now() - t2}ms`);

    // 关键步骤3：解析属性（最耗时）
    const t3 = Date.now();
    const slides_attributes = await getSlidesAttributes(slides, screenshotsDir);
    console.log(`[PPTX] 解析幻灯片属性耗时: ${Date.now() - t3}ms`);

    // 关键步骤4：截图处理
    const t4 = Date.now();
    await postProcessSlidesAttributes(
      slides_attributes,
      screenshotsDir,
      speakerNotes
    );
    console.log(`[PPTX] 截图处理耗时: ${Date.now() - t4}ms`);

    // 关键步骤5：转换模型
    const t5 = Date.now();
    const slides_pptx_models = convertElementAttributesToPptxSlides(slides_attributes);
    const presentation_pptx_model: PptxPresentationModel = {
      slides: slides_pptx_models,
    };
    console.log(`[PPTX] 转换模型耗时: ${Date.now() - t5}ms`);

    await closeBrowserAndPage(browser, page);

    const totalTime = Date.now() - startTime;
    console.log(`[PPTX] ✅ 总耗时: ${totalTime}ms`);

    // 在 return NextResponse.json(presentation_pptx_model); 之前

const debugPath = '/mnt/d/work/python/ppt/temp/debug.json';
fs.writeFileSync(debugPath, JSON.stringify(presentation_pptx_model, null, 2));
console.log(`[PPTX] 💾 数据已保存到: ${debugPath}`);

return NextResponse.json(presentation_pptx_model);
  } catch (error: any) {
    console.error(`[PPTX] ❌ 错误: ${error.message}`);
    console.error(error);
    await closeBrowserAndPage(browser, page);
    if (error instanceof ApiError) {
      return NextResponse.json(error, { status: 400 });
    }
    return NextResponse.json(
      { detail: `Internal server error: ${error.message}` },
      { status: 500 }
    );
  }
}

async function getPresentationId(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    throw new ApiError("Presentation ID not found");
  }
  return id;
}

async function getBrowserAndPage(id: string): Promise<[Browser, Page]> {
  const launchStart = Date.now();

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-web-security",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=TranslateUI",
      "--disable-ipc-flooding-protection",
    ],
  });

  console.log(`[PPTX] 浏览器启动: ${Date.now() - launchStart}ms`);

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  page.setDefaultNavigationTimeout(300000);
  page.setDefaultTimeout(300000);

  // 🔥 修改：请求拦截
  await page.setRequestInterception(true);

  const fastApiUrl = process.env.FASTAPI_URL || 'http://localhost:8000';
  console.log(`[PPTX] FastAPI URL: ${fastApiUrl}`);

  page.on('request', (interceptedRequest) => {
    const url = interceptedRequest.url();

    // 拦截 /static/ 请求
    if (url.includes('/static/')) {
      const urlObj = new URL(url);
      const staticPath = urlObj.pathname;
      const fastApiStaticUrl = `${fastApiUrl}${staticPath}`;

      console.log(`[PPTX] 🔄 拦截到静态资源请求: ${staticPath}`);
      console.log(`[PPTX] 🔄 将重定向到: ${fastApiStaticUrl}`);

      // 🔥 使用 fetch 异步获取，但不阻塞
      fetch(fastApiStaticUrl)
        .then(response => {
          if (response.ok) {
            return response.arrayBuffer().then(buffer => {
              const contentType = response.headers.get('content-type') || 'application/octet-stream';
              console.log(`[PPTX] ✅ 成功获取: ${staticPath} (${contentType})`);

              interceptedRequest.respond({
                status: 200,
                contentType: contentType,
                body: Buffer.from(buffer)
              });
            });
          } else {
            console.warn(`[PPTX] ⚠️  FastAPI返回${response.status}: ${fastApiStaticUrl}`);
            interceptedRequest.continue();
          }
        })
        .catch(error => {
          console.error(`[PPTX] ❌ 获取失败: ${fastApiStaticUrl} - ${error.message}`);
          interceptedRequest.continue();
        });

      return; // 重要：拦截处理，不再继续
    }

    // 打印其他请求（用于调试）
    if (!url.includes('/_next/') && !url.includes('.js') && !url.includes('.css')) {
      console.log(`[PPTX] 请求: ${url}`);
    }

    // 其他请求继续
    interceptedRequest.continue();
  });

  // 其他监听器
  page.on('requestfailed', request => {
    console.log(`[PPTX] ❌ 请求失败: ${request.url()} - ${request.failure()?.errorText}`);
  });

  page.on('response', response => {
    const status = response.status();
    const url = response.url();
    if (status >= 400 && url.includes('/static/')) {
      console.log(`[PPTX] ⚠️  静态资源响应错误 ${status}: ${url}`);
    }
  });

  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('RemoteSvgIcon') || text.includes('Failed to load')) {
      console.log(`[PPTX] 浏览器控制台: ${text}`);
    }
  });

  const pageLoadStart = Date.now();

  await page.goto(`http://localhost:3000/pdf-maker?id=${id}`, {
    waitUntil: "domcontentloaded",
    timeout: 300000,
  });
  console.log(`[PPTX] 页面导航完成: ${Date.now() - pageLoadStart}ms`);

  // 等待关键元素出现
 const waitStart = Date.now();
  console.log(`[PPTX] 等待关键元素 #presentation-slides-wrapper...`);

  try {
    await page.waitForSelector("#presentation-slides-wrapper", { timeout: 60000 });
    console.log(`[PPTX] ✅ 元素渲染完成: ${Date.now() - waitStart}ms`);
  } catch (error) {
    console.error(`[PPTX] ❌ 等待元素超时，开始诊断...`);

    // 诊断1: 检查元素是否存在
    const exists = await page.evaluate(() => {
      return !!document.querySelector("#presentation-slides-wrapper");
    });
    console.log(`[PPTX] 元素是否存在: ${exists}`);

    // 诊断2: 检查所有pending的请求
    const pendingRequests = await page.evaluate(() => {
      const performance = window.performance;
      const resources = performance.getEntriesByType('resource');
      return resources
        .filter((r: any) => !r.responseEnd)
        .map((r: any) => ({ name: r.name, duration: r.duration }));
    });
    console.log(`[PPTX] 待完成的请求数: ${pendingRequests.length}`);
    if (pendingRequests.length > 0) {
      console.log(`[PPTX] 待完成的请求:`, pendingRequests.slice(0, 10));
    }

    // 诊断3: 检查所有失败的请求
    const failedResources = await page.evaluate(() => {
      const performance = window.performance;
      const resources = performance.getEntriesByType('resource');
      return resources
        .filter((r: any) => r.responseEnd === 0)
        .map((r: any) => r.name);
    });
    if (failedResources.length > 0) {
      console.log(`[PPTX] 失败的请求:`, failedResources);
    }

    // 诊断4: 获取页面状态
    const pageState = await page.evaluate(() => {
      return {
        readyState: document.readyState,
        bodyChildren: document.body?.children.length || 0,
        hasWrapper: !!document.querySelector("#presentation-slides-wrapper"),
        bodyHTML: document.body?.innerHTML.substring(0, 500)
      };
    });
    console.log(`[PPTX] 页面状态:`, pageState);

    throw error;
  }

  // 额外等待确保内容渲染
  console.log(`[PPTX] 等待内容渲染...`);
  const slideCount = await page.evaluate(() => {
    const wrapper = document.querySelector('#presentation-slides-wrapper');
    return wrapper ? wrapper.querySelectorAll(':scope > div > div').length : 0;
  });
  console.log(`[PPTX] 检测到 ${slideCount} 张幻灯片`);

  if (slideCount === 0) {
    console.warn(`[PPTX] ⚠️  未检测到幻灯片，继续等待...`);
    try {
      await page.waitForFunction(
        () => {
          const wrapper = document.querySelector('#presentation-slides-wrapper');
          return wrapper && wrapper.querySelectorAll(':scope > div > div').length > 0;
        },
        { timeout: 30000 }
      );
      const newCount = await page.evaluate(() => {
        const wrapper = document.querySelector('#presentation-slides-wrapper');
        return wrapper ? wrapper.querySelectorAll(':scope > div > div').length : 0;
      });
      console.log(`[PPTX] 重新检测到 ${newCount} 张幻灯片`);
    } catch (err) {
      console.error(`[PPTX] ❌ 等待幻灯片超时`);
      // 打印更多调试信息
      const debugInfo = await page.evaluate(() => {
        const wrapper = document.querySelector('#presentation-slides-wrapper');
        return {
          wrapperHTML: wrapper?.innerHTML.substring(0, 1000),
          wrapperChildren: wrapper?.children.length,
          allDivs: document.querySelectorAll('div').length
        };
      });
      console.log(`[PPTX] 调试信息:`, debugInfo);
    }
  }
// 在 await new Promise(resolve => setTimeout(resolve, 2000)); 之前添加：

// 🔥 等待所有网络请求完成
console.log(`[PPTX] ⏳ 等待所有网络请求完成...`);
try {
  await page.waitForNetworkIdle({ timeout: 10000, idleTime: 500 });
  console.log(`[PPTX] ✅ 网络请求已完成`);
} catch (error) {
  console.warn(`[PPTX] ⚠️  网络空闲等待超时，继续处理...`);
}

// 🔥 检查是否还有待完成的请求
const pendingRequests = await page.evaluate(() => {
  const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  return resources
    .filter(r => r.responseEnd === 0 || !r.responseEnd)
    .map(r => ({
      name: r.name,
      duration: r.duration,
      initiatorType: r.initiatorType
    }));
});

if (pendingRequests.length > 0) {
  console.warn(`[PPTX] ⚠️  还有 ${pendingRequests.length} 个请求未完成:`);
  pendingRequests.slice(0, 5).forEach(req => {
    console.warn(`[PPTX]   └─ ${req.name}`);
  });
}
  // 额外等待2秒确保异步内容加载
  await new Promise(resolve => setTimeout(resolve, 2000));
  // 🔥 新增：检查所有 SVG 元素的实际内容
const svgLoadStatus = await page.evaluate(() => {
  const svgs = Array.from(document.querySelectorAll('svg'));

  return svgs.map((svg, index) => {
    const rect = svg.getBoundingClientRect();
    const computedStyle = window.getComputedStyle(svg);

    // 检查 SVG 内部结构
    const hasChildren = svg.children.length > 0;
    const hasUse = svg.querySelector('use') !== null;
    const hasPath = svg.querySelector('path') !== null;
    const hasImage = svg.querySelector('image') !== null;

    // 获取 use 元素的 href
    const useElements = Array.from(svg.querySelectorAll('use'));
    const useHrefs = useElements.map(use =>
      use.getAttribute('href') || use.getAttribute('xlink:href')
    );

    // 检查引用的元素是否存在
    const hrefResolved = useHrefs.map(href => {
      if (!href) return null;
      const targetId = href.startsWith('#') ? href.substring(1) : href;
      const targetElement = document.getElementById(targetId);
      return {
        href,
        exists: !!targetElement,
        elementType: targetElement?.tagName
      };
    });

    return {
      index,
      visible: rect.width > 0 && rect.height > 0,
      dimensions: { width: rect.width, height: rect.height },
      hasChildren,
      childCount: svg.children.length,
      hasUse,
      hasPath,
      hasImage,
      useHrefs,
      hrefResolved,
      outerHTML: svg.outerHTML.substring(0, 300),
      className: svg.className.baseVal || svg.className,
      opacity: computedStyle.opacity,
      display: computedStyle.display
    };
  });
});

console.log(`[PPTX] 🔍 SVG 加载状态检查 (共 ${svgLoadStatus.length} 个):`);
svgLoadStatus.forEach((status, i) => {
  console.log(`[PPTX]   SVG #${i + 1}:`);
  console.log(`[PPTX]     └─ 可见: ${status.visible}`);
  console.log(`[PPTX]     └─ 尺寸: ${status.dimensions.width}x${status.dimensions.height}`);
  console.log(`[PPTX]     └─ 子元素数: ${status.childCount}`);
  console.log(`[PPTX]     └─ 包含 <use>: ${status.hasUse}`);
  console.log(`[PPTX]     └─ 包含 <path>: ${status.hasPath}`);
  console.log(`[PPTX]     └─ className: ${status.className}`);

  if (status.useHrefs.length > 0) {
    console.log(`[PPTX]     └─ use hrefs:`, status.useHrefs);
    console.log(`[PPTX]     └─ href 解析:`, status.hrefResolved);
  }

  if (!status.visible || status.childCount === 0) {
    console.warn(`[PPTX]     └─ ⚠️  问题: SVG 不可见或无内容`);
    console.warn(`[PPTX]     └─ HTML: ${status.outerHTML}`);
  }
});

// 🔥 检查 SVG sprite 或 symbol 定义
const svgDefinitions = await page.evaluate(() => {
  const defs = document.querySelectorAll('defs, symbol');
  return Array.from(defs).map(def => ({
    tagName: def.tagName,
    id: def.id,
    childCount: def.children.length,
    parentTag: def.parentElement?.tagName
  }));
});

if (svgDefinitions.length > 0) {
  console.log(`[PPTX] 🔍 发现 SVG 定义 (defs/symbol): ${svgDefinitions.length} 个`);
  svgDefinitions.forEach(def => {
    console.log(`[PPTX]   └─ <${def.tagName}> id="${def.id}" (${def.childCount} children)`);
  });
}
   console.log(`[PPTX] 内容渲染等待完成`);

  // 🔥 添加这段 - 检查页面中的SVG和Table
  const pageElementStats = await page.evaluate(() => {
    const svgs = document.querySelectorAll('svg');
    const tables = document.querySelectorAll('table');
    const canvases = document.querySelectorAll('canvas');
    const images = document.querySelectorAll('img');
    return {
      svgCount: svgs.length,
      tableCount: tables.length,
      canvasCount: canvases.length,
      imageCount: images.length,
      failedImages: Array.from(images).filter(img => !img.complete || img.naturalHeight === 0).length
    };
  });
  // 🔥 添加这段 - 诊断所有SVG和图片的来源
  const resourceSources = await page.evaluate(() => {
    const svgs = Array.from(document.querySelectorAll('svg'));
    const images = Array.from(document.querySelectorAll('img'));
    const elements = Array.from(document.querySelectorAll('*'));

    // 检查所有可能包含远程资源的属性
    const remoteResources: any[] = [];

    elements.forEach((el, index) => {
      const style = window.getComputedStyle(el);
      const bgImage = style.backgroundImage;

      // 检查background-image中的URL
      if (bgImage && bgImage !== 'none' && bgImage.includes('url(')) {
        const match = bgImage.match(/url\(['"]?([^'"]+)['"]?\)/);
        if (match && match[1]) {
          const url = match[1];
          if (url.startsWith('http') || url.startsWith('//')) {
            remoteResources.push({
              type: 'background-image',
              element: el.tagName,
              url: url,
              className: el.className
            });
          }
        }
      }
    });

    // 检查img标签
    images.forEach(img => {
      if (img.src && (img.src.startsWith('http') || img.src.startsWith('//'))) {
        remoteResources.push({
          type: 'img',
          src: img.src,
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          className: img.className
        });
      }
    });

    // 检查SVG - 包括内联SVG和use引用
    const svgInfo = svgs.map((svg, i) => {
      const uses = svg.querySelectorAll('use');
      const images = svg.querySelectorAll('image');

      return {
        index: i,
        outerHTML: svg.outerHTML.substring(0, 200),
        hasUse: uses.length > 0,
        useHrefs: Array.from(uses).map(use => use.getAttribute('href') || use.getAttribute('xlink:href')),
        hasImage: images.length > 0,
        imageHrefs: Array.from(images).map(img => img.getAttribute('href') || img.getAttribute('xlink:href')),
        children: svg.children.length,
        className: svg.className.baseVal || svg.className
      };
    });

    return {
      remoteResources,
      svgInfo,
      totalElements: elements.length
    };
  });

  console.log(`[PPTX] 资源来源分析:`);
  console.log(`[PPTX]   远程资源数量: ${resourceSources.remoteResources.length}`);
  if (resourceSources.remoteResources.length > 0) {
    console.log(`[PPTX]   远程资源详情:`, JSON.stringify(resourceSources.remoteResources, null, 2));
  }
  console.log(`[PPTX]   SVG详情:`, JSON.stringify(resourceSources.svgInfo, null, 2));

  return [browser, page];
}

async function closeBrowserAndPage(browser: Browser | null, page: Page | null) {
  await page?.close();
  await browser?.close();
}

function getScreenshotsDir() {
  const tempDir = process.env.TEMP_DIRECTORY;
  if (!tempDir) {
    console.warn(
      "TEMP_DIRECTORY environment variable not set, skipping screenshot"
    );
    throw new ApiError("TEMP_DIRECTORY environment variable not set");
  }
  const screenshotsDir = path.join(tempDir, "screenshots").replace(/\\/g, '/');
  console.log("====screenshotsDir-=====:"+screenshotsDir)
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }
  return screenshotsDir;
}

async function postProcessSlidesAttributes(
  slidesAttributes: SlideAttributesResult[],
  screenshotsDir: string,
  speakerNotes: string[]
) {
  let screenshotCount = 0;
  const screenshotStart = Date.now();
  const screenshotDetails: { type: string; success: boolean; error?: string }[] = [];

  for (const [index, slideAttributes] of slidesAttributes.entries()) {
    console.log(`[PPTX] 处理幻灯片${index + 1}截图...`);

    for (const element of slideAttributes.elements) {
      if (element.should_screenshot) {
        try {
          const screenshotPath = await screenshotElement(element, screenshotsDir);
          screenshotCount++;
          element.imageSrc = screenshotPath;
          element.should_screenshot = false;
          element.objectFit = "cover";
          element.element = undefined;

          screenshotDetails.push({ type: element.tagName, success: true });
          console.log(`[PPTX]   ✅ 截图成功: ${element.tagName} -> ${path.basename(screenshotPath)}`);
        } catch (error: any) {
          screenshotDetails.push({
            type: element.tagName,
            success: false,
            error: error.message
          });
          console.error(`[PPTX]   ❌ 截图失败: ${element.tagName} - ${error.message}`);
        }
      }
    }
    slideAttributes.speakerNote = speakerNotes[index];
  }

  if (screenshotCount > 0) {
    console.log(`[PPTX] 截图${screenshotCount}个元素，平均${Math.round((Date.now() - screenshotStart) / screenshotCount)}ms/个`);
  }

  // 统计截图结果
  const successCount = screenshotDetails.filter(d => d.success).length;
  const failCount = screenshotDetails.filter(d => !d.success).length;
  console.log(`[PPTX] 截图统计: 成功${successCount} 失败${failCount}`);

  if (failCount > 0) {
    const failedTypes = screenshotDetails
      .filter(d => !d.success)
      .map(d => `${d.type}(${d.error})`)
      .join(', ');
    console.error(`[PPTX] 失败的元素: ${failedTypes}`);
  }
}

async function screenshotElement(
  element: ElementAttributes,
  screenshotsDir: string
) {
 const screenshotPath = path.join(
    screenshotsDir,
    `${uuidv4()}.png`
  ).replace(/\\/g, '/') as `${string}.png`;

  console.log(`[PPTX]   └─ 截图路径: ${screenshotPath}`);

  if (element.tagName === "svg") {
    console.log(`[PPTX]   └─ 处理SVG元素...`);
    try {
      const pngBuffer = await convertSvgToPng(element);
      console.log(`[PPTX]   └─ ✅ SVG转PNG成功，buffer大小: ${pngBuffer.length} bytes`);
      fs.writeFileSync(screenshotPath, pngBuffer);
      console.log(`[PPTX]   └─ ✅ SVG截图保存成功`);

      // 🔥 验证文件是否真的被创建
      if (fs.existsSync(screenshotPath)) {
        const stats = fs.statSync(screenshotPath);
        console.log(`[PPTX]   └─ ✅ 文件验证成功，大小: ${stats.size} bytes`);
      } else {
        console.error(`[PPTX]   └─ ❌ 文件未创建: ${screenshotPath}`);
      }

      return screenshotPath;
    } catch (error: any) {
      console.error(`[PPTX]   └─ ❌ SVG转PNG失败: ${error.message}`);
      throw error;
    }
  }

  await element.element?.evaluate(
    (el) => {
      const originalOpacities = new Map();

      const hideAllExcept = (targetElement: Element) => {
        const allElements = document.querySelectorAll("*");

        allElements.forEach((elem) => {
          const computedStyle = window.getComputedStyle(elem);
          originalOpacities.set(elem, computedStyle.opacity);

          if (
            targetElement === elem ||
            targetElement.contains(elem) ||
            elem.contains(targetElement)
          ) {
            (elem as HTMLElement).style.opacity = computedStyle.opacity || "1";
            return;
          }

          (elem as HTMLElement).style.opacity = "0";
        });
      };

      hideAllExcept(el);

      (el as any).__restoreStyles = () => {
        originalOpacities.forEach((opacity, elem) => {
          (elem as HTMLElement).style.opacity = opacity;
        });
      };
    },
    element.opacity,
    element.font?.color
  );

  const screenshot = await element.element?.screenshot({
    path: screenshotPath,
  });
  if (!screenshot) {
    throw new ApiError("Failed to screenshot element");
  }

  await element.element?.evaluate((el) => {
    if ((el as any).__restoreStyles) {
      (el as any).__restoreStyles();
    }
  });

  return screenshotPath;
}

const convertSvgToPng = async (element_attibutes: ElementAttributes) => {
  console.log(`[PPTX] 🔄 convertSvgToPng 开始...`);

  const svgHtml =
    (await element_attibutes.element?.evaluate((el) => {
      const fontColor = window.getComputedStyle(el).color;
      (el as HTMLElement).style.color = fontColor;

      // 🔥 新增：检查 SVG 内部结构
      const svg = el as SVGElement;
      const childCount = svg.children.length;
      const hasUse = svg.querySelector('use') !== null;
      const hasPath = svg.querySelector('path') !== null;

      console.log(`[浏览器] SVG 子元素数: ${childCount}`);
      console.log(`[浏览器] 包含 <use>: ${hasUse}`);
      console.log(`[浏览器] 包含 <path>: ${hasPath}`);

      // 🔥 如果是 <use> 元素，尝试解析引用
      if (hasUse) {
        const useElement = svg.querySelector('use');
        const href = useElement?.getAttribute('href') || useElement?.getAttribute('xlink:href');
        console.log(`[浏览器] use href: ${href}`);

        if (href && href.startsWith('#')) {
          const targetId = href.substring(1);
          const targetElement = document.getElementById(targetId);
          console.log(`[浏览器] 引用目标 #${targetId} 存在: ${!!targetElement}`);

          if (targetElement) {
            // 🔥 尝试内联引用的内容
            const clone = svg.cloneNode(true) as SVGElement;
            const useInClone = clone.querySelector('use');
            if (useInClone && targetElement.children.length > 0) {
              // 替换 <use> 为实际内容
              const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
              Array.from(targetElement.children).forEach(child => {
                g.appendChild(child.cloneNode(true));
              });
              useInClone.parentNode?.replaceChild(g, useInClone);
              console.log(`[浏览器] ✅ 已内联 <use> 引用`);
              return clone.outerHTML;
            }
          }
        }
      }

      return el.outerHTML;
    })) || "";

  console.log(`[PPTX]   └─ SVG HTML 长度: ${svgHtml.length} 字符`);
  console.log(`[PPTX]   └─ SVG HTML 前500字符:\n${svgHtml.substring(0, 500)}`);

  // 🔥 检查 SVG 是否实际上是空的
  const hasContent = svgHtml.includes('<path') ||
                     svgHtml.includes('<circle') ||
                     svgHtml.includes('<rect') ||
                     svgHtml.includes('<polygon') ||
                     svgHtml.includes('<line') ||
                     svgHtml.includes('<g');

  if (!hasContent && svgHtml.includes('<use')) {
    console.warn(`[PPTX]   └─ ⚠️  SVG 只包含 <use> 引用，可能无法正确渲染`);
  }

  if (!hasContent) {
    console.error(`[PPTX]   └─ ❌ SVG 没有实际图形内容！`);
  }

  const svgBuffer = Buffer.from(svgHtml);
  console.log(`[PPTX]   └─ SVG Buffer 大小: ${svgBuffer.length} bytes`);

  try {
    const pngBuffer = await sharp(svgBuffer)
      .resize(
        Math.round(element_attibutes.position!.width!),
        Math.round(element_attibutes.position!.height!)
      )
      .toFormat("png")
      .toBuffer();

    console.log(`[PPTX]   └─ ✅ Sharp 转换成功，PNG 大小: ${pngBuffer.length} bytes`);

    // 🔥 检查生成的 PNG 是否过小（可能是空白）
    if (pngBuffer.length < 1000) {
      console.warn(`[PPTX]   └─ ⚠️  PNG 文件过小 (${pngBuffer.length} bytes)，可能是空白图片`);
    }

    return pngBuffer;
  } catch (error: any) {
    console.error(`[PPTX]   └─ ❌ Sharp 转换失败: ${error.message}`);
    console.error(`[PPTX]   └─ SVG 内容导致错误:\n${svgHtml.substring(0, 1000)}`);
    throw error;
  }
};
async function getSlidesAttributes(
  slides: ElementHandle<Element>[],
  screenshotsDir: string
): Promise<SlideAttributesResult[]> {
  const slideAttributes: SlideAttributesResult[] = [];

  for (let i = 0; i < slides.length; i++) {
    const slideStart = Date.now();
    const attributes = await getAllChildElementsAttributes({
      element: slides[i],
      screenshotsDir
    });

    // 🔥 统计元素类型
    const elementTypes = attributes.elements.reduce((acc, el) => {
      acc[el.tagName] = (acc[el.tagName] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const svgCount = elementTypes['svg'] || 0;
    const tableCount = elementTypes['table'] || 0;
    const canvasCount = elementTypes['canvas'] || 0;
    const screenshotCount = attributes.elements.filter(el => el.should_screenshot).length;

    console.log(`[PPTX] 幻灯片${i + 1}/${slides.length}: ${Date.now() - slideStart}ms (${attributes.elements.length}个元素)`);
    console.log(`[PPTX]   └─ SVG:${svgCount} Table:${tableCount} Canvas:${canvasCount} 需截图:${screenshotCount}`);
    console.log(`[PPTX]   └─ 元素类型:`, elementTypes);

    slideAttributes.push(attributes);
  }

  return slideAttributes;
}
async function getSlidesAndSpeakerNotes(page: Page) {
  const slides_wrapper = await getSlidesWrapper(page);
  const speakerNotes = await getSpeakerNotes(slides_wrapper);
  const slides = await slides_wrapper.$$(":scope > div > div");
  return { slides, speakerNotes };
}

async function getSlidesWrapper(page: Page): Promise<ElementHandle<Element>> {
  const slides_wrapper = await page.$("#presentation-slides-wrapper");
  if (!slides_wrapper) {
    throw new ApiError("Presentation slides not found");
  }
  return slides_wrapper;
}

async function getSpeakerNotes(slides_wrapper: ElementHandle<Element>) {
  return await slides_wrapper.evaluate((el) => {
    return Array.from(el.querySelectorAll("[data-speaker-note]")).map(
      (el) => el.getAttribute("data-speaker-note") || ""
    );
  });
}

async function getAllChildElementsAttributes({
  element,
  rootRect = null,
  depth = 0,
  inheritedFont,
  inheritedBackground,
  inheritedBorderRadius,
  inheritedZIndex,
  inheritedOpacity,
  screenshotsDir,
}: GetAllChildElementsAttributesArgs): Promise<SlideAttributesResult> {
  if (!rootRect) {
    const rootAttributes = await getElementAttributes(element);
    inheritedFont = rootAttributes.font;
    inheritedBackground = rootAttributes.background;
    inheritedZIndex = rootAttributes.zIndex;
    inheritedOpacity = rootAttributes.opacity;
    rootRect = {
      left: rootAttributes.position?.left ?? 0,
      top: rootAttributes.position?.top ?? 0,
      width: rootAttributes.position?.width ?? 1280,
      height: rootAttributes.position?.height ?? 720,
    };
  }

  const directChildElementHandles = await element.$$(":scope > *");

  const allResults: { attributes: ElementAttributes; depth: number }[] = [];

  for (const childElementHandle of directChildElementHandles) {
    const attributes = await getElementAttributes(childElementHandle);

    if (
      ["style", "script", "link", "meta", "path"].includes(attributes.tagName)
    ) {
      continue;
    }

    if (
      inheritedFont &&
      !attributes.font &&
      attributes.innerText &&
      attributes.innerText.trim().length > 0
    ) {
      attributes.font = inheritedFont;
    }
    if (inheritedBackground && !attributes.background && attributes.shadow) {
      attributes.background = inheritedBackground;
    }
    if (inheritedBorderRadius && !attributes.borderRadius) {
      attributes.borderRadius = inheritedBorderRadius;
    }
    if (inheritedZIndex !== undefined && attributes.zIndex === 0) {
      attributes.zIndex = inheritedZIndex;
    }
    if (
      inheritedOpacity !== undefined &&
      (attributes.opacity === undefined || attributes.opacity === 1)
    ) {
      attributes.opacity = inheritedOpacity;
    }

    if (
      attributes.position &&
      attributes.position.left !== undefined &&
      attributes.position.top !== undefined
    ) {
      attributes.position = {
        left: attributes.position.left - rootRect!.left,
        top: attributes.position.top - rootRect!.top,
        width: attributes.position.width,
        height: attributes.position.height,
      };
    }

    if (
      attributes.position === undefined ||
      attributes.position.width === undefined ||
      attributes.position.height === undefined ||
      attributes.position.width === 0 ||
      attributes.position.height === 0
    ) {
      continue;
    }

    if (attributes.tagName === "p") {
      const innerElementTagNames = await childElementHandle.evaluate((el) => {
        return Array.from(el.querySelectorAll("*")).map((e) =>
          e.tagName.toLowerCase()
        );
      });

      const allowedInlineTags = new Set(["strong", "u", "em", "code", "s"]);
      const hasOnlyAllowedInlineTags = innerElementTagNames.every((tag) =>
        allowedInlineTags.has(tag)
      );

      if (innerElementTagNames.length > 0 && hasOnlyAllowedInlineTags) {
        attributes.innerText = await childElementHandle.evaluate((el) => {
          return el.innerHTML;
        });
        allResults.push({ attributes, depth });
        continue;
      }
    }

    if (
      attributes.tagName === "svg" ||
      attributes.tagName === "canvas" ||
      attributes.tagName === "table"
    ) {
      attributes.should_screenshot = true;
      attributes.element = childElementHandle;
    }

    allResults.push({ attributes, depth });

    if (attributes.should_screenshot && attributes.tagName !== "svg") {
      continue;
    }

    const childResults = await getAllChildElementsAttributes({
      element: childElementHandle,
      rootRect: rootRect,
      depth: depth + 1,
      inheritedFont: attributes.font || inheritedFont,
      inheritedBackground: attributes.background || inheritedBackground,
      inheritedBorderRadius: attributes.borderRadius || inheritedBorderRadius,
      inheritedZIndex: attributes.zIndex || inheritedZIndex,
      inheritedOpacity: attributes.opacity || inheritedOpacity,
      screenshotsDir,
    });
    allResults.push(
      ...childResults.elements.map((attr) => ({
        attributes: attr,
        depth: depth + 1,
      }))
    );
  }

  let backgroundColor = inheritedBackground?.color;
  if (depth === 0) {
    const elementsWithRootPosition = allResults.filter(({ attributes }) => {
      return (
        attributes.position &&
        attributes.position.left === 0 &&
        attributes.position.top === 0 &&
        attributes.position.width === rootRect!.width &&
        attributes.position.height === rootRect!.height
      );
    });

    for (const { attributes } of elementsWithRootPosition) {
      if (attributes.background && attributes.background.color) {
        backgroundColor = attributes.background.color;
        break;
      }
    }
  }

  const filteredResults =
    depth === 0
      ? allResults.filter(({ attributes }) => {
          const hasBackground =
            attributes.background && attributes.background.color;
          const hasBorder = attributes.border && attributes.border.color;
          const hasShadow = attributes.shadow && attributes.shadow.color;
          const hasText =
            attributes.innerText && attributes.innerText.trim().length > 0;
          const hasImage = attributes.imageSrc;
          const isSvg = attributes.tagName === "svg";
          const isCanvas = attributes.tagName === "canvas";
          const isTable = attributes.tagName === "table";

          const occupiesRoot =
            attributes.position &&
            attributes.position.left === 0 &&
            attributes.position.top === 0 &&
            attributes.position.width === rootRect!.width &&
            attributes.position.height === rootRect!.height;

          const hasVisualProperties =
            hasBackground || hasBorder || hasShadow || hasText;
          const hasSpecialContent = hasImage || isSvg || isCanvas || isTable;

          return (hasVisualProperties && !occupiesRoot) || hasSpecialContent;
        })
      : allResults;

  if (depth === 0) {
    const sortedElements = filteredResults
      .sort((a, b) => {
        const zIndexA = a.attributes.zIndex || 0;
        const zIndexB = b.attributes.zIndex || 0;

        if (zIndexA === zIndexB) {
          return a.depth - b.depth;
        }

        return zIndexB - zIndexA;
      })
      .map(({ attributes }) => {
        if (
          attributes.shadow &&
          attributes.shadow.color &&
          (!attributes.background || !attributes.background.color) &&
          backgroundColor
        ) {
          attributes.background = {
            color: backgroundColor,
            opacity: undefined,
          };
        }
        return attributes;
      });

    return {
      elements: sortedElements,
      backgroundColor,
    };
  } else {
    return {
      elements: filteredResults.map(({ attributes }) => attributes),
      backgroundColor,
    };
  }
}

async function getElementAttributes(
  element: ElementHandle<Element>
): Promise<ElementAttributes> {
  const attributes = await element.evaluate((el: Element) => {
    function colorToHex(color: string): {
      hex: string | undefined;
      opacity: number | undefined;
    } {
      if (!color || color === "transparent" || color === "rgba(0, 0, 0, 0)") {
        return { hex: undefined, opacity: undefined };
      }

      if (color.startsWith("rgba(") || color.startsWith("hsla(")) {
        const match = color.match(/rgba?\(([^)]+)\)|hsla?\(([^)]+)\)/);
        if (match) {
          const values = match[1] || match[2];
          const parts = values.split(",").map((part) => part.trim());

          if (parts.length >= 4) {
            const opacity = parseFloat(parts[3]);
            const rgbColor = color
              .replace(/rgba?\(|hsla?\(|\)/g, "")
              .split(",")
              .slice(0, 3)
              .join(",");
            const rgbString = color.startsWith("rgba")
              ? `rgb(${rgbColor})`
              : `hsl(${rgbColor})`;

            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            if (ctx) {
              ctx.fillStyle = rgbString;
              const hexColor = ctx.fillStyle;
              const hex = hexColor.startsWith("#")
                ? hexColor.substring(1)
                : hexColor;
              const result = {
                hex,
                opacity: isNaN(opacity) ? undefined : opacity,
              };

              return result;
            }
          }
        }
      }

      if (color.startsWith("rgb(") || color.startsWith("hsl(")) {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.fillStyle = color;
          const hexColor = ctx.fillStyle;
          const hex = hexColor.startsWith("#")
            ? hexColor.substring(1)
            : hexColor;
          return { hex, opacity: undefined };
        }
      }

      if (color.startsWith("#")) {
        const hex = color.substring(1);
        return { hex, opacity: undefined };
      }

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return { hex: color, opacity: undefined };

      ctx.fillStyle = color;
      const hexColor = ctx.fillStyle;
      const hex = hexColor.startsWith("#") ? hexColor.substring(1) : hexColor;
      const result = { hex, opacity: undefined };

      return result;
    }

    function hasOnlyTextNodes(el: Element): boolean {
      const children = el.childNodes;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeType === Node.ELEMENT_NODE) {
          return false;
        }
      }
      return true;
    }

    function parsePosition(el: Element) {
      const rect = el.getBoundingClientRect();
      return {
        left: isFinite(rect.left) ? rect.left : 0,
        top: isFinite(rect.top) ? rect.top : 0,
        width: isFinite(rect.width) ? rect.width : 0,
        height: isFinite(rect.height) ? rect.height : 0,
      };
    }

    function parseBackground(computedStyles: CSSStyleDeclaration) {
      const backgroundColorResult = colorToHex(computedStyles.backgroundColor);

      const background = {
        color: backgroundColorResult.hex,
        opacity: backgroundColorResult.opacity,
      };

      if (!background.color && background.opacity === undefined) {
        return undefined;
      }

      return background;
    }

    function parseBackgroundImage(computedStyles: CSSStyleDeclaration) {
      const backgroundImage = computedStyles.backgroundImage;

      if (!backgroundImage || backgroundImage === "none") {
        return undefined;
      }

      const urlMatch = backgroundImage.match(/url\(['"]?([^'"]+)['"]?\)/);
      if (urlMatch && urlMatch[1]) {
        return urlMatch[1];
      }

      return undefined;
    }

    function parseBorder(computedStyles: CSSStyleDeclaration) {
      const borderColorResult = colorToHex(computedStyles.borderColor);
      const borderWidth = parseFloat(computedStyles.borderWidth);

      if (borderWidth === 0) {
        return undefined;
      }

      const border = {
        color: borderColorResult.hex,
        width: isNaN(borderWidth) ? undefined : borderWidth,
        opacity: borderColorResult.opacity,
      };

      if (
        !border.color &&
        border.width === undefined &&
        border.opacity === undefined
      ) {
        return undefined;
      }

      return border;
    }

    function parseShadow(computedStyles: CSSStyleDeclaration) {
      const boxShadow = computedStyles.boxShadow;
      let shadow: {
        offset?: [number, number];
        color?: string;
        opacity?: number;
        radius?: number;
        angle?: number;
        spread?: number;
        inset?: boolean;
      } = {};

      if (boxShadow && boxShadow !== "none") {
        const shadows: string[] = [];
        let currentShadow = "";
        let parenCount = 0;

        for (let i = 0; i < boxShadow.length; i++) {
          const char = boxShadow[i];
          if (char === "(") {
            parenCount++;
          } else if (char === ")") {
            parenCount--;
          } else if (char === "," && parenCount === 0) {
            shadows.push(currentShadow.trim());
            currentShadow = "";
            continue;
          }
          currentShadow += char;
        }

        if (currentShadow.trim()) {
          shadows.push(currentShadow.trim());
        }

        let selectedShadow = "";
        let bestShadowScore = -1;

        for (let i = 0; i < shadows.length; i++) {
          const shadowStr = shadows[i];

          const shadowParts = shadowStr.split(" ");
          const numericParts: number[] = [];
          const colorParts: string[] = [];
          let isInset = false;
          let currentColor = "";
          let inColorFunction = false;

          for (let j = 0; j < shadowParts.length; j++) {
            const part = shadowParts[j];
            const trimmedPart = part.trim();
            if (trimmedPart === "") continue;

            if (trimmedPart.toLowerCase() === "inset") {
              isInset = true;
              continue;
            }

            if (trimmedPart.match(/^(rgba?|hsla?)\s*\(/i)) {
              inColorFunction = true;
              currentColor = trimmedPart;
              continue;
            }

            if (inColorFunction) {
              currentColor += " " + trimmedPart;

              const openParens = (currentColor.match(/\(/g) || []).length;
              const closeParens = (currentColor.match(/\)/g) || []).length;

              if (openParens <= closeParens) {
                colorParts.push(currentColor);
                currentColor = "";
                inColorFunction = false;
              }
              continue;
            }

            const numericValue = parseFloat(trimmedPart);
            if (!isNaN(numericValue)) {
              numericParts.push(numericValue);
            } else {
              colorParts.push(trimmedPart);
            }
          }

          let hasVisibleColor = false;
          if (colorParts.length > 0) {
            const shadowColor = colorParts.join(" ");
            const colorResult = colorToHex(shadowColor);
            hasVisibleColor = !!(
              colorResult.hex &&
              colorResult.hex !== "000000" &&
              colorResult.opacity !== 0
            );
          }

          const hasNonZeroValues = numericParts.some((value) => value !== 0);

          let shadowScore = 0;
          if (hasNonZeroValues) {
            shadowScore += numericParts.filter((value) => value !== 0).length;
          }
          if (hasVisibleColor) {
            shadowScore += 2;
          }

          if (
            (hasNonZeroValues || hasVisibleColor) &&
            shadowScore > bestShadowScore
          ) {
            selectedShadow = shadowStr;
            bestShadowScore = shadowScore;
          }
        }

        if (!selectedShadow && shadows.length > 0) {
          selectedShadow = shadows[0];
        }

        if (selectedShadow) {
          const shadowParts = selectedShadow.split(" ");
          const numericParts: number[] = [];
          const colorParts: string[] = [];
          let isInset = false;
          let currentColor = "";
          let inColorFunction = false;

          for (let i = 0; i < shadowParts.length; i++) {
            const part = shadowParts[i];
            const trimmedPart = part.trim();
            if (trimmedPart === "") continue;

            if (trimmedPart.toLowerCase() === "inset") {
              isInset = true;
              continue;
            }

            if (trimmedPart.match(/^(rgba?|hsla?)\s*\(/i)) {
              inColorFunction = true;
              currentColor = trimmedPart;
              continue;
            }

            if (inColorFunction) {
              currentColor += " " + trimmedPart;

              const openParens = (currentColor.match(/\(/g) || []).length;
              const closeParens = (currentColor.match(/\)/g) || []).length;

              if (openParens <= closeParens) {
                colorParts.push(currentColor);
                currentColor = "";
                inColorFunction = false;
              }
              continue;
            }

            const numericValue = parseFloat(trimmedPart);
            if (!isNaN(numericValue)) {
              numericParts.push(numericValue);
            } else {
              colorParts.push(trimmedPart);
            }
          }

          if (numericParts.length >= 2) {
            const offsetX = numericParts[0];
            const offsetY = numericParts[1];
            const blurRadius = numericParts.length >= 3 ? numericParts[2] : 0;
            const spreadRadius = numericParts.length >= 4 ? numericParts[3] : 0;

            if (colorParts.length > 0) {
              const shadowColor = colorParts.join(" ");
              const shadowColorResult = colorToHex(shadowColor);

              if (shadowColorResult.hex) {
                shadow = {
                  offset: [offsetX, offsetY],
                  color: shadowColorResult.hex,
                  opacity: shadowColorResult.opacity,
                  radius: blurRadius,
                  spread: spreadRadius,
                  inset: isInset,
                  angle: Math.atan2(offsetY, offsetX) * (180 / Math.PI),
                };
              }
            }
          }
        }
      }

      if (Object.keys(shadow).length === 0) {
        return undefined;
      }

      return shadow;
    }

    function parseFont(computedStyles: CSSStyleDeclaration) {
      const fontSize = parseFloat(computedStyles.fontSize);
      const fontWeight = parseInt(computedStyles.fontWeight);
      const fontColorResult = colorToHex(computedStyles.color);
      const fontFamily = computedStyles.fontFamily;
      const fontStyle = computedStyles.fontStyle;

      let fontName = undefined;
      if (fontFamily !== "initial") {
        const firstFont = fontFamily.split(",")[0].trim().replace(/['"]/g, "");
        fontName = firstFont;
      }

      const font = {
        name: fontName,
        size: isNaN(fontSize) ? undefined : fontSize,
        weight: isNaN(fontWeight) ? undefined : fontWeight,
        color: fontColorResult.hex,
        italic: fontStyle === "italic",
      };

      if (
        !font.name &&
        font.size === undefined &&
        font.weight === undefined &&
        !font.color &&
        !font.italic
      ) {
        return undefined;
      }

      return font;
    }

    function parseLineHeight(computedStyles: CSSStyleDeclaration, el: Element) {
      const lineHeight = computedStyles.lineHeight;
      const innerText = el.textContent || "";

      const htmlEl = el as HTMLElement;

      const fontSize = parseFloat(computedStyles.fontSize);
      const computedLineHeight = parseFloat(computedStyles.lineHeight);

      const singleLineHeight = !isNaN(computedLineHeight)
        ? computedLineHeight
        : fontSize * 1.2;

      const hasExplicitLineBreaks =
        innerText.includes("\n") ||
        innerText.includes("\r") ||
        innerText.includes("\r\n");
      const hasTextWrapping = htmlEl.offsetHeight > singleLineHeight * 2;
      const hasOverflow = htmlEl.scrollHeight > htmlEl.clientHeight;

      const isMultiline =
        hasExplicitLineBreaks || hasTextWrapping || hasOverflow;

      if (isMultiline && lineHeight && lineHeight !== "normal") {
        const parsedLineHeight = parseFloat(lineHeight);
        if (!isNaN(parsedLineHeight)) {
          return parsedLineHeight;
        }
      }

      return undefined;
    }

    function parseMargin(computedStyles: CSSStyleDeclaration) {
      const marginTop = parseFloat(computedStyles.marginTop);
      const marginBottom = parseFloat(computedStyles.marginBottom);
      const marginLeft = parseFloat(computedStyles.marginLeft);
      const marginRight = parseFloat(computedStyles.marginRight);
      const marginObj = {
        top: isNaN(marginTop) ? undefined : marginTop,
        bottom: isNaN(marginBottom) ? undefined : marginBottom,
        left: isNaN(marginLeft) ? undefined : marginLeft,
        right: isNaN(marginRight) ? undefined : marginRight,
      };

      return marginObj.top === 0 &&
        marginObj.bottom === 0 &&
        marginObj.left === 0 &&
        marginObj.right === 0
        ? undefined
        : marginObj;
    }

    function parsePadding(computedStyles: CSSStyleDeclaration) {
      const paddingTop = parseFloat(computedStyles.paddingTop);
      const paddingBottom = parseFloat(computedStyles.paddingBottom);
      const paddingLeft = parseFloat(computedStyles.paddingLeft);
      const paddingRight = parseFloat(computedStyles.paddingRight);
      const paddingObj = {
        top: isNaN(paddingTop) ? undefined : paddingTop,
        bottom: isNaN(paddingBottom) ? undefined : paddingBottom,
        left: isNaN(paddingLeft) ? undefined : paddingLeft,
        right: isNaN(paddingRight) ? undefined : paddingRight,
      };

      return paddingObj.top === 0 &&
        paddingObj.bottom === 0 &&
        paddingObj.left === 0 &&
        paddingObj.right === 0
        ? undefined
        : paddingObj;
    }

    function parseBorderRadius(
      computedStyles: CSSStyleDeclaration,
      el: Element
    ) {
      const borderRadius = computedStyles.borderRadius;
      let borderRadiusValue;

      if (borderRadius && borderRadius !== "0px") {
        const radiusParts = borderRadius
          .split(" ")
          .map((part) => parseFloat(part));
        if (radiusParts.length === 1) {
          borderRadiusValue = [
            radiusParts[0],
            radiusParts[0],
            radiusParts[0],
            radiusParts[0],
          ];
        } else if (radiusParts.length === 2) {
          borderRadiusValue = [
            radiusParts[0],
            radiusParts[1],
            radiusParts[0],
            radiusParts[1],
          ];
        } else if (radiusParts.length === 3) {
          borderRadiusValue = [
            radiusParts[0],
            radiusParts[1],
            radiusParts[2],
            radiusParts[1],
          ];
        } else if (radiusParts.length === 4) {
          borderRadiusValue = radiusParts;
        }

        if (borderRadiusValue) {
          const rect = el.getBoundingClientRect();
          const maxRadiusX = rect.width / 2;
          const maxRadiusY = rect.height / 2;

          borderRadiusValue = borderRadiusValue.map((radius, index) => {
            const maxRadius =
              index === 0 || index === 2 ? maxRadiusX : maxRadiusY;
            return Math.max(0, Math.min(radius, maxRadius));
          });
        }
      }

      return borderRadiusValue;
    }

    function parseShape(el: Element, borderRadiusValue: number[] | undefined) {
      if (el.tagName.toLowerCase() === "img") {
        return borderRadiusValue &&
          borderRadiusValue.length === 4 &&
          borderRadiusValue.every((radius: number) => radius === 50)
          ? "circle"
          : "rectangle";
      }
      return undefined;
    }

    function parseFilters(computedStyles: CSSStyleDeclaration) {
      const filter = computedStyles.filter;
      if (!filter || filter === "none") {
        return undefined;
      }

      const filters: {
        invert?: number;
        brightness?: number;
        contrast?: number;
        saturate?: number;
        hueRotate?: number;
        blur?: number;
        grayscale?: number;
        sepia?: number;
        opacity?: number;
      } = {};

      const filterFunctions = filter.match(/[a-zA-Z]+\([^)]*\)/g);
      if (filterFunctions) {
        filterFunctions.forEach((func) => {
          const match = func.match(/([a-zA-Z]+)\(([^)]*)\)/);
          if (match) {
            const filterType = match[1];
            const value = parseFloat(match[2]);

            if (!isNaN(value)) {
              switch (filterType) {
                case "invert":
                  filters.invert = value;
                  break;
                case "brightness":
                  filters.brightness = value;
                  break;
                case "contrast":
                  filters.contrast = value;
                  break;
                case "saturate":
                  filters.saturate = value;
                  break;
                case "hue-rotate":
                  filters.hueRotate = value;
                  break;
                case "blur":
                  filters.blur = value;
                  break;
                case "grayscale":
                  filters.grayscale = value;
                  break;
                case "sepia":
                  filters.sepia = value;
                  break;
                case "opacity":
                  filters.opacity = value;
                  break;
              }
            }
          }
        });
      }

      return Object.keys(filters).length > 0 ? filters : undefined;
    }

    function parseElementAttributes(el: Element) {
      let tagName = el.tagName.toLowerCase();

      const computedStyles = window.getComputedStyle(el);

      const position = parsePosition(el);

      const shadow = parseShadow(computedStyles);

      const background = parseBackground(computedStyles);

      const border = parseBorder(computedStyles);

      const font = parseFont(computedStyles);

      const lineHeight = parseLineHeight(computedStyles, el);

      const margin = parseMargin(computedStyles);

      const padding = parsePadding(computedStyles);

      const innerText = hasOnlyTextNodes(el)
        ? el.textContent || undefined
        : undefined;

      const zIndex = parseInt(computedStyles.zIndex);
      const zIndexValue = isNaN(zIndex) ? 0 : zIndex;

      const textAlign = computedStyles.textAlign as
        | "left"
        | "center"
        | "right"
        | "justify";
      const objectFit = computedStyles.objectFit as
        | "contain"
        | "cover"
        | "fill"
        | undefined;

      const parsedBackgroundImage = parseBackgroundImage(computedStyles);
      const imageSrc = (el as HTMLImageElement).src || parsedBackgroundImage;

      const borderRadiusValue = parseBorderRadius(computedStyles, el);

      const shape = parseShape(el, borderRadiusValue) as
        | "rectangle"
        | "circle"
        | undefined;

      const textWrap = computedStyles.whiteSpace !== "nowrap";

      const filters = parseFilters(computedStyles);

      const opacity = parseFloat(computedStyles.opacity);
      const elementOpacity = isNaN(opacity) ? undefined : opacity;

      return {
        tagName: tagName,
        id: el.id,
        className:
          el.className && typeof el.className === "string"
            ? el.className
            : el.className
            ? el.className.toString()
            : undefined,
        innerText: innerText,
        opacity: elementOpacity,
        background: background,
        border: border,
        shadow: shadow,
        font: font,
        position: position,
        margin: margin,
        padding: padding,
        zIndex: zIndexValue,
        textAlign: textAlign !== "left" ? textAlign : undefined,
        lineHeight: lineHeight,
        borderRadius: borderRadiusValue,
        imageSrc: imageSrc,
        objectFit: objectFit,
        clip: false,
        overlay: undefined,
        shape: shape,
        connectorType: undefined,
        textWrap: textWrap,
        should_screenshot: false,
        element: undefined,
        filters: filters,
      };
    }

    return parseElementAttributes(el);
  });
  return attributes;
}