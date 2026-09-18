import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const posterTool = defineTool({
  name: "pi_compose_model_product_poster",
  label: "Compose Model Product Poster",
  description:
    "Create and verify an exact-size marketing poster from one background, title artwork, model, product, and watermark. All five absolute asset paths are required. The deterministic runtime calculates alpha-visible bounds, uniform scales, placement, HTML, PNG, and verification.",
  parameters: Type.Object({
    background: Type.String({ description: "Absolute path to the background image" }),
    title: Type.String({ description: "Absolute path to the title artwork" }),
    model: Type.String({ description: "Absolute path to the required model/person image" }),
    product: Type.String({ description: "Absolute path to the product image" }),
    watermark: Type.String({ description: "Absolute path to the watermark/registration image" }),
    outputDir: Type.String({ description: "Absolute directory for poster outputs" }),
    productClass: Type.Optional(
      Type.Union([
        Type.Literal("auto"),
        Type.Literal("small-handheld"),
        Type.Literal("medium"),
        Type.Literal("large"),
      ]),
    ),
    modelSide: Type.Optional(
      Type.Union([Type.Literal("auto"), Type.Literal("left"), Type.Literal("right")]),
    ),
    hierarchy: Type.Optional(
      Type.Union([
        Type.Literal("balanced"),
        Type.Literal("model-led"),
        Type.Literal("product-led"),
      ]),
    ),
    brief: Type.Optional(Type.String({ description: "Short user composition requirement" })),
  }),

  async execute(_toolCallId, params, signal, onUpdate, _ctx) {
    const outputDir = resolve(params.outputDir);
    await mkdir(outputDir, { recursive: true });
    const jobPath = join(outputDir, "job.json");
    const job = {
      background: resolve(params.background),
      title: resolve(params.title),
      model: resolve(params.model),
      product: resolve(params.product),
      watermark: resolve(params.watermark),
      outputDir,
      productClass: params.productClass ?? "auto",
      modelSide: params.modelSide ?? "auto",
      hierarchy: params.hierarchy ?? "balanced",
      brief: params.brief ?? "",
    };
    await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");
    onUpdate?.({ content: [{ type: "text", text: "正在检测素材尺寸和透明边界…" }] });

    const child = execFileAsync("python3", [join(packageRoot, "scripts", "run_poster.py"), jobPath], {
      cwd: packageRoot,
      maxBuffer: 16 * 1024 * 1024,
    });
    const abort = () => child.child?.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const { stdout, stderr } = await child;
      const resultPath = join(outputDir, "result.json");
      const result = JSON.parse(await readFile(resultPath, "utf8"));
      const html = await readFile(result.outputs.posterHtml, "utf8");
      if (!/^\s*<!doctype html>/i.test(html) || !/<\/html>\s*$/i.test(html)) {
        throw new Error("Generated poster.html is not a complete HTML document");
      }
      return {
        content: [
          {
            type: "text",
            text: html,
          },
        ],
        details: {
          ...result,
          responseContract: "Return the tool text verbatim as the final response. Do not add Markdown fences or prose.",
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        },
      };
    } catch (error) {
      let detail = error instanceof Error ? error.message : String(error);
      try {
        detail = await readFile(join(outputDir, "render-error.json"), "utf8");
      } catch {
        // Keep the process error when the runtime could not write a structured error.
      }
      throw new Error(`Poster pipeline failed: ${detail}`);
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(posterTool);
}
