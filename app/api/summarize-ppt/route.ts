export const runtime = "nodejs";

type StreamWriter = WritableStreamDefaultWriter<Uint8Array>;

function collectTexts(node: unknown, out: string[]) {
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
}

function numericSlideSort(a: string, b: string) {
  const aNum = Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
  const bNum = Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
  return aNum - bNum;
}

async function summarizeSlide(text: string, slideIndex: number) {
  const apiKey = process.env.QWEN_API_KEY;
  if (!apiKey) {
    throw new Error("Missing QWEN_API_KEY in environment.");
  }
  if (/[^\x00-\x7F]/.test(apiKey)) {
    throw new Error(
      "QWEN_API_KEY contains non-ASCII characters. Please paste the real key."
    );
  }

  const baseUrl =
    process.env.QWEN_BASE_URL ??
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
  const model = process.env.QWEN_MODEL ?? "qwen-flash";

  const content = text
    ? text.slice(0, 8000)
    : "(这一页没有可解析的文本)";

  const body = {
    model,
    messages: [
      {
        role: "system",
        content:
          "你是严谨的中文摘要助手。输出一段不超过120字的摘要。",
      },
      {
        role: "user",
        content: `请总结第 ${slideIndex + 1} 页内容：\n${content}`,
      },
    ],
    temperature: 0.2,
  };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Qwen API error: ${res.status} ${errText}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };

  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

function sendEvent(
  writer: StreamWriter,
  event: string,
  data: Record<string, unknown>
) {
  const encoder = new TextEncoder();
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return writer.write(encoder.encode(payload));
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { slides?: string[] };
    const slides = body.slides ?? [];

    if (!Array.isArray(slides) || slides.length === 0) {
      return Response.json({ error: "No slides provided." }, { status: 400 });
    }

    if (slides.length > 50) {
      return Response.json(
        { error: "Slides exceed 50. Please upload a smaller file." },
        { status: 400 }
      );
    }

    const stream = new TransformStream<Uint8Array>();
    const writer = stream.writable.getWriter();

    (async () => {
      try {
        for (let i = 0; i < slides.length; i += 1) {
          const summary = await summarizeSlide(slides[i], i);
          await sendEvent(writer, "summary", {
            index: i,
            summary,
            slideCount: slides.length,
          });
        }
        await sendEvent(writer, "done", { slideCount: slides.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        await sendEvent(writer, "error", { message });
      } finally {
        writer.close();
      }
    })();

    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
