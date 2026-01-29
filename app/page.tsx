"use client";

import { useState } from "react";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [summaries, setSummaries] = useState<string[]>([]);
  const [slideCount, setSlideCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [controller, setController] = useState<AbortController | null>(null);

  const collectTexts = (node: unknown, out: string[]) => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") return;
    if (Array.isArray(node)) {
      for (const item of node) collectTexts(item, out);
      return;
    }
    if (typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "t" && typeof value === "string") {
          out.push(value);
        } else {
          collectTexts(value, out);
        }
      }
    }
  };

  const numericSlideSort = (a: string, b: string) => {
    const aNum = Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
    const bNum = Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
    return aNum - bNum;
  };

  const extractSlidesText = async (file: File) => {
    const buffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buffer);
    const slideFiles = Object.keys(zip.files)
      .filter(
        (name) => name.startsWith("ppt/slides/slide") && name.endsWith(".xml")
      )
      .sort(numericSlideSort);

    const parser = new XMLParser({
      ignoreAttributes: true,
      removeNSPrefix: true,
    });

    const slides: string[] = [];
    for (const fileName of slideFiles) {
      const xml = await zip.file(fileName)?.async("string");
      if (!xml) {
        slides.push("");
        continue;
      }
      const json = parser.parse(xml);
      const texts: string[] = [];
      collectTexts(json, texts);
      slides.push(texts.join(" ").replace(/\s+/g, " ").trim());
    }

    return slides;
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSummaries([]);
    setSlideCount(null);
    setProgress(0);
    controller?.abort();

    if (!file) {
      setError("请先选择一个 .pptx 文件。");
      return;
    }

    if (!file.name.endsWith(".pptx")) {
      setError("仅支持 .pptx 文件。");
      return;
    }

    setLoading(true);
    const abortController = new AbortController();
    setController(abortController);
    try {
      const slides = await extractSlidesText(file);
      if (slides.length === 0) {
        throw new Error("未解析到任何页面内容。");
      }
      if (slides.length > 50) {
        throw new Error("页数超过 50，请上传更小的文件。");
      }

      const res = await fetch("/api/summarize-ppt", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ slides }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "处理失败，请稍后再试。");
      }

      if (!res.body) {
        throw new Error("服务端未返回流式数据。");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const lines = part.split("\n").filter(Boolean);
          let event = "message";
          let dataLine = "";
          for (const line of lines) {
            if (line.startsWith("event:")) {
              event = line.replace("event:", "").trim();
            } else if (line.startsWith("data:")) {
              dataLine += line.replace("data:", "").trim();
            }
          }
          if (!dataLine) continue;
          const payload = JSON.parse(dataLine) as {
            index?: number;
            summary?: string;
            slideCount?: number;
            message?: string;
          };

          if (payload.slideCount) {
            setSlideCount(payload.slideCount);
          }

          if (event === "summary" && payload.index !== undefined) {
            setSummaries((prev) => {
              const next = [...prev];
              next[payload.index!] = payload.summary ?? "";
              return next;
            });
            setProgress((prev) => prev + 1);
          }

          if (event === "error") {
            throw new Error(payload.message || "处理失败，请稍后再试。");
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setError("已取消分析。");
      } else {
        setError(err instanceof Error ? err.message : "未知错误");
      }
    } finally {
      setLoading(false);
      setController(null);
    }
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_#ffe7d0,_#f8f5ef_45%,_#e9f0ff_100%)] text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-10 px-6 py-14">
        <header className="flex flex-col gap-6">
          <div className="inline-flex w-fit items-center gap-2 rounded-full border border-slate-200 bg-white/70 px-4 py-1 text-sm backdrop-blur">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            Qwen PPT 摘要器
          </div>
          <div className="flex flex-col gap-4">
            <h1 className="text-4xl font-semibold leading-tight sm:text-5xl">
              上传 PPTX，逐页生成中文摘要
            </h1>
            <p className="max-w-2xl text-lg text-slate-600">
              支持最多 50 页。系统会解析每页文本并调用 Qwen 模型输出简洁摘要，结果直接在页面展示。
            </p>
          </div>
        </header>

        <section className="grid gap-8 rounded-3xl border border-white/70 bg-white/80 p-6 shadow-xl shadow-slate-200/50 backdrop-blur sm:p-8">
          <form className="grid gap-4" onSubmit={onSubmit}>
            <label className="grid gap-2 text-sm font-medium text-slate-700">
              选择 .pptx 文件
              <input
                type="file"
                accept=".pptx"
                className="file:mr-4 file:rounded-full file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-slate-800"
                onChange={(event) => {
                  const selected = event.currentTarget.files?.[0] ?? null;
                  setFile(selected);
                }}
              />
            </label>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={loading}
                className="rounded-full bg-slate-900 px-6 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? "正在分析..." : "开始分析"}
              </button>
              {loading && (
                <button
                  type="button"
                  onClick={() => controller?.abort()}
                  className="rounded-full border border-slate-300 px-6 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-900"
                >
                  取消
                </button>
              )}
              {file && (
                <span className="text-sm text-slate-600">
                  已选择：{file.name}
                </span>
              )}
            </div>
          </form>

          {loading && (
            <div className="grid gap-2">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>分析进度</span>
                <span>
                  {progress}/{slideCount ?? "?"}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full bg-emerald-500 transition-all"
                  style={{
                    width:
                      slideCount && slideCount > 0
                        ? `${Math.min(100, (progress / slideCount) * 100)}%`
                        : "0%",
                  }}
                />
              </div>
            </div>
          )}

          <div className="text-sm text-slate-600">
            如已配置好环境变量即可直接使用；需要更改模型或接口地址再回到服务器端调整。
          </div>
        </section>

        <section className="grid gap-4">
          {error && (
            <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {error}
            </div>
          )}

          {summaries.length > 0 && (
            <div className="grid gap-4">
              <div className="text-sm text-slate-600">
                已完成 {slideCount ?? summaries.length} 页摘要
              </div>
              <div className="grid gap-4">
                {summaries.map((summary, index) => (
                  <div
                    key={`${index + 1}-${summary.slice(0, 8)}`}
                    className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
                  >
                    <div className="text-xs uppercase tracking-wide text-slate-400">
                      第 {index + 1} 页
                    </div>
                    <p className="mt-2 text-sm leading-6 text-slate-700">
                      {summary || "(无摘要输出)"}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
