import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const h3PromptTool = defineTool({
  name: "pi_generate_h3_live_model_prompt",
  label: "Generate H3 Live Model Prompt",
  description:
    "Use MiniMax-M3 multimodal understanding to analyze one model reference image and one product poster, then return a verified, ready-to-copy MiniMax H3 multi-reference video prompt. This creates a prompt only; it does not generate HTML or video.",
  parameters: Type.Object({
    modelImage: Type.String({ description: "Absolute local path or public URL of the model/person reference image" }),
    posterImage: Type.String({ description: "Absolute local path or public URL of the product marketing poster used as product and scene reference" }),
    duration: Type.Optional(Type.Number({ description: "Video duration in seconds; default 5" })),
    motionStrength: Type.Optional(
      Type.Union([Type.Literal("subtle"), Type.Literal("balanced"), Type.Literal("vivid")]),
    ),
    brief: Type.Optional(Type.String({ description: "Optional user requirements for motion, mood, or product presentation" })),
  }),

  async execute(_toolCallId, params, signal, onUpdate, _ctx) {
    const work = await mkdtemp(join(tmpdir(), "pi-h3-prompt-"));
    const output = join(work, "h3-prompt.json");
    const args = [
      join(packageRoot, "scripts", "generate_h3_prompt.py"),
      "--model-image", params.modelImage,
      "--poster-image", params.posterImage,
      "--duration", String(params.duration ?? 5),
      "--motion-strength", params.motionStrength ?? "vivid",
      "--output", output,
    ];
    if (params.brief) args.push("--brief", params.brief);

    onUpdate?.({ content: [{ type: "text", text: "正在用 M3 分析人物表演、商品 hero moment、背景流动与标题动效…" }] });
    const child = execFileAsync("python3", args, {
      cwd: packageRoot,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    });
    const abort = () => child.child?.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await child;
      const result = JSON.parse(await readFile(output, "utf8"));
      if (result.status !== "success" || result.verification?.passed !== true) {
        throw new Error("M3 prompt result did not pass verification");
      }
      const paramsText = JSON.stringify(result.recommended_params, null, 2);
      const text = [
        "## H3 可直接复制提示词",
        "",
        result.h3_prompt,
        "",
        "## 参考图职责",
        "",
        "- 图 1：模特身份、外观、初始姿势和动作依据。",
        "- 图 2：商品、文字、Logo、背景、色彩和广告构图依据（multi-reference，不强制设为首帧）。",
        "",
        "## 建议创建参数",
        "",
        paramsText,
      ].join("\n");
      return { content: [{ type: "text", text }], details: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`H3 prompt generation failed: ${message}`);
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(h3PromptTool);
}
