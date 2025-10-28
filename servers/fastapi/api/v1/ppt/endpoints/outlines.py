import asyncio
import json
import math
import traceback
import uuid
import dirtyjson
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime

from models.presentation_outline_model import PresentationOutlineModel
from models.sql.presentation import PresentationModel
from models.sse_response import (
    SSECompleteResponse,
    SSEErrorResponse,
    SSEResponse,
    SSEStatusResponse,
)
from services.temp_file_service import TEMP_FILE_SERVICE
from services.database import get_async_session
from services.documents_loader import DocumentsLoader
from utils.llm_calls.generate_presentation_outlines import generate_ppt_outline
from utils.ppt_utils import get_presentation_title_from_outlines

OUTLINES_ROUTER = APIRouter(prefix="/outlines", tags=["Outlines"])


def debug_log(message: str, **kwargs):
    """统一的调试日志函数"""
    timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    extra = " | ".join([f"{k}={v}" for k, v in kwargs.items()]) if kwargs else ""
    print(f"[{timestamp}] 🔍 {message} {extra}", flush=True)


@OUTLINES_ROUTER.get("/stream/{id}")
async def stream_outlines(
        id: uuid.UUID, sql_session: AsyncSession = Depends(get_async_session)
):
    debug_log("=== STREAM START ===", presentation_id=str(id))

    presentation = await sql_session.get(PresentationModel, id)

    if not presentation:
        debug_log("❌ Presentation not found", presentation_id=str(id))
        raise HTTPException(status_code=404, detail="Presentation not found")

    debug_log("✅ Presentation found", presentation_id=str(id))
    temp_dir = TEMP_FILE_SERVICE.create_temp_dir()

    async def inner():
        # ⚠️ 关键修复：使用 flag 来跟踪是否正常完成
        completed = False

        try:
            debug_log("📤 [YIELD 1] Sending connected status")
            yield SSEStatusResponse(status="connected").to_string()
            debug_log("✅ [YIELD 1] Connected status sent")

            await asyncio.sleep(0.05)

            debug_log("📤 [YIELD 2] Sending initializing status")
            yield SSEStatusResponse(status="Initializing presentation generation...").to_string()
            debug_log("✅ [YIELD 2] Initializing status sent")

            await asyncio.sleep(0.05)

            # 加载文档上下文
            additional_context = ""
            if presentation.file_paths:
                debug_log("📂 Loading documents", count=len(presentation.file_paths))
                yield SSEStatusResponse(status="Loading documents...").to_string()

                documents_loader = DocumentsLoader(file_paths=presentation.file_paths)
                await documents_loader.load_documents(temp_dir)
                documents = documents_loader.documents
                if documents:
                    additional_context = "\n\n".join(documents)

                debug_log("✅ Documents loaded", count=len(documents))
                yield SSEStatusResponse(status=f"Loaded {len(documents)} document(s)").to_string()

            # 计算需要生成的幻灯片数量
            presentation_outlines_text = ""
            n_slides_to_generate = presentation.n_slides

            if presentation.include_table_of_contents:
                needed_toc_count = math.ceil((presentation.n_slides - 1) / 10)
                n_slides_to_generate -= math.ceil(
                    (presentation.n_slides - needed_toc_count) / 10
                )

            debug_log("🎯 Starting slide generation", n_slides=n_slides_to_generate)
            yield SSEStatusResponse(status=f"Generating {n_slides_to_generate} slide outlines...").to_string()

            await asyncio.sleep(0.05)

            # 流式生成 PPT outline
            chunk_count = 0
            total_chars = 0

            debug_log("🚀 Entering generate_ppt_outline loop")

            # ⚠️ 关键修复：使用 try-finally 确保能检测到提前退出
            try:
                async for chunk in generate_ppt_outline(
                        presentation.content,
                        n_slides_to_generate,
                        presentation.language,
                        additional_context,
                        presentation.tone,
                        presentation.verbosity,
                        presentation.instructions,
                        presentation.include_title_slide,
                        presentation.web_search,
                ):
                    chunk_count += 1
                    chunk_size = len(chunk) if chunk else 0
                    total_chars += chunk_size

                    debug_log(
                        f"📦 [CHUNK {chunk_count}] Received from generate_ppt_outline",
                        size=chunk_size,
                        total_chars=total_chars,
                        preview=chunk[:50] if chunk else "None"
                    )

                    # 让出控制权给事件循环
                    await asyncio.sleep(0)

                    if isinstance(chunk, HTTPException):
                        debug_log(f"❌ [CHUNK {chunk_count}] HTTPException received", detail=chunk.detail)
                        yield SSEErrorResponse(detail=chunk.detail).to_string()
                        return

                    # 构造 SSE 消息
                    sse_message = SSEResponse(
                        event="response",
                        data=json.dumps({"type": "chunk", "chunk": chunk}),
                    ).to_string()

                    debug_log(
                        f"📤 [CHUNK {chunk_count}] Yielding SSE",
                        sse_length=len(sse_message)
                    )

                    debug_log(f"⏳ [CHUNK {chunk_count}] Before yield")

                    # ⚠️ 关键修复：在这里可能会被中断
                    yield sse_message

                    debug_log(f"✅ [CHUNK {chunk_count}] After yield")

                    presentation_outlines_text += chunk

                    # 每 10 个 chunk 发送一次状态
                    if chunk_count % 10 == 0:
                        debug_log(f"💓 [HEARTBEAT] Sending status", chunk_count=chunk_count)
                        yield SSEStatusResponse(status="generating").to_string()
                        debug_log(f"✅ [HEARTBEAT] Status sent")

                debug_log("🏁 Finished generate_ppt_outline loop", total_chunks=chunk_count, total_chars=total_chars)

            except GeneratorExit:
                # ⚠️ 这个异常说明客户端断开或者 StreamingResponse 停止了
                debug_log("⚠️ GeneratorExit caught - client disconnected or stream stopped")
                raise
            except Exception as e:
                debug_log("❌ Exception in chunk loop", error=str(e), type=type(e).__name__)
                traceback.print_exc()
                raise

            # 解析最终的 JSON
            debug_log("🔍 Parsing generated content", content_length=len(presentation_outlines_text))
            yield SSEStatusResponse(status="Parsing generated content...").to_string()

            try:
                presentation_outlines_json = dict(
                    dirtyjson.loads(presentation_outlines_text)
                )
                debug_log("✅ JSON parsed successfully")
            except Exception as e:
                debug_log("❌ JSON parsing failed", error=str(e))
                traceback.print_exc()
                yield SSEErrorResponse(
                    detail=f"Failed to parse presentation outlines: {str(e)}",
                ).to_string()
                return

            # 创建 outline 模型
            presentation_outlines = PresentationOutlineModel(**presentation_outlines_json)
            debug_log("✅ Outline model created", slides_count=len(presentation_outlines.slides))

            # 截取到需要的幻灯片数量
            presentation_outlines.slides = presentation_outlines.slides[:n_slides_to_generate]

            # 保存到数据库
            debug_log("💾 Saving to database")
            yield SSEStatusResponse(status="Saving presentation...").to_string()

            presentation.outlines = presentation_outlines.model_dump()
            presentation.title = get_presentation_title_from_outlines(presentation_outlines)

            sql_session.add(presentation)
            await sql_session.commit()
            debug_log("✅ Saved to database")

            # 发送完成消息
            debug_log("📤 Sending completion message")
            yield SSECompleteResponse(
                key="presentation",
                value=presentation.model_dump(mode="json")
            ).to_string()
            debug_log("✅ Completion message sent")

            # 发送关闭消息
            debug_log("📤 Sending closing message")
            yield SSEResponse(
                event="response",
                data=json.dumps({"type": "closing", "message": "Stream completed"}),
            ).to_string()
            debug_log("✅ Closing message sent")

            completed = True
            debug_log("=== STREAM END (COMPLETED) ===")

        except GeneratorExit:
            debug_log("⚠️ GeneratorExit in inner() - stream was interrupted")
            # 不要 raise，让它正常结束

        except HTTPException as he:
            debug_log("❌ HTTPException in stream", detail=he.detail)
            traceback.print_exc()
            try:
                yield SSEErrorResponse(detail=he.detail).to_string()
            except GeneratorExit:
                debug_log("⚠️ GeneratorExit while yielding error")

        except Exception as e:
            debug_log("❌ Unexpected exception in stream", error=str(e), type=type(e).__name__)
            traceback.print_exc()
            try:
                yield SSEErrorResponse(detail=f"Unexpected error: {str(e)}").to_string()
            except GeneratorExit:
                debug_log("⚠️ GeneratorExit while yielding error")

        finally:
            if not completed:
                debug_log("⚠️ Stream did NOT complete normally!")

            debug_log("🧹 Cleaning up temp dir")
            try:
                TEMP_FILE_SERVICE.cleanup_temp_dir(temp_dir)
                debug_log("✅ Temp dir cleaned")
            except Exception as cleanup_error:
                debug_log("❌ Cleanup error", error=str(cleanup_error))
                print(f"Error cleaning up temp dir: {cleanup_error}")

    return StreamingResponse(
        inner(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "Content-Type": "text/event-stream",
            "X-Accel-Buffering": "no",
            "Access-Control-Allow-Origin": "*",
        }
    )


@OUTLINES_ROUTER.get("/{id}")
async def get_outlines(
        id: uuid.UUID,
        sql_session: AsyncSession = Depends(get_async_session)
):
    """Polling fallback endpoint"""
    presentation = await sql_session.get(PresentationModel, id)

    if not presentation:
        raise HTTPException(status_code=404, detail="Presentation not found")

    return {
        "id": str(presentation.id),
        "status": "completed" if presentation.outlines else "generating",
        "slides": presentation.outlines.get("slides", []) if presentation.outlines else [],
        "title": presentation.title,
    }