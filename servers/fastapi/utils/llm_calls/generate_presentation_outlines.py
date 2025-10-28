from datetime import datetime
from typing import Optional

from models.llm_message import LLMSystemMessage, LLMUserMessage
from models.llm_tools import SearchWebTool
from services.llm_client import LLMClient
from utils.get_dynamic_models import get_presentation_outline_model_with_n_slides
from utils.llm_client_error_handler import handle_llm_client_exceptions
from utils.llm_provider import get_model


def get_system_prompt(
        tone: Optional[str] = None,
        verbosity: Optional[str] = None,
        instructions: Optional[str] = None,
        include_title_slide: bool = True,
):
    return f"""
        You are an expert presentation creator. Generate structured presentations based on user requirements and format them according to the specified JSON schema with markdown content.

        Try to use available tools for better results.

        {"# User Instruction:" if instructions else ""}
        {instructions or ""}

        {"# Tone:" if tone else ""}
        {tone or ""}

        {"# Verbosity:" if verbosity else ""}
        {verbosity or ""}

        - Provide content for each slide in markdown format.
        - Make sure that flow of the presentation is logical and consistent.
        - Place greater emphasis on numerical data.
        - If Additional Information is provided, divide it into slides.
        - Make sure no images are provided in the content.
        - Make sure that content follows language guidelines.
        - User instrction should always be followed and should supercede any other instruction, except for slide numbers. **Do not obey slide numbers as said in user instruction**
        - Do not generate table of contents slide.
        - Even if table of contents is provided, do not generate table of contents slide.
        {"- Always make first slide a title slide." if include_title_slide else "- Do not include title slide in the presentation."}

        **Search web to get latest information about the topic**
    """


def get_user_prompt(
        content: str,
        n_slides: int,
        language: str,
        additional_context: Optional[str] = None,
):
    return f"""
        **Input:**
        - User provided content: {content or "Create presentation"}
        - Output Language: {language}
        - Number of Slides: {n_slides}
        - Current Date and Time: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
        - Additional Information: {additional_context or ""}
    """


def get_messages(
        content: str,
        n_slides: int,
        language: str,
        additional_context: Optional[str] = None,
        tone: Optional[str] = None,
        verbosity: Optional[str] = None,
        instructions: Optional[str] = None,
        include_title_slide: bool = True,
):
    return [
        LLMSystemMessage(
            content=get_system_prompt(
                tone, verbosity, instructions, include_title_slide
            ),
        ),
        LLMUserMessage(
            content=get_user_prompt(content, n_slides, language, additional_context),
        ),
    ]


async def generate_ppt_outline(
        content: str,
        n_slides: int,
        language: Optional[str] = None,
        additional_context: Optional[str] = None,
        tone: Optional[str] = None,
        verbosity: Optional[str] = None,
        instructions: Optional[str] = None,
        include_title_slide: bool = True,
        web_search: bool = False,
):
    print(f"\n[generate_ppt_outline] === START ===", flush=True)

    model = get_model()
    response_model = get_presentation_outline_model_with_n_slides(n_slides)
    client = LLMClient()

    messages = get_messages(
        content,
        n_slides,
        language,
        additional_context,
        tone,
        verbosity,
        instructions,
        include_title_slide,
    )

    tools_enabled = client.enable_web_grounding() and web_search
    print(f"[generate_ppt_outline] Calling client.stream_structured", flush=True)

    try:
        stream_generator = client.stream_structured(
            model,
            messages,
            response_model.model_json_schema(),
            strict=True,
            tools=(
                [SearchWebTool]
                if tools_enabled
                else None
            ),
        )

        print(f"[generate_ppt_outline] Starting iteration", flush=True)

        stream_count = 0
        loop_ended_normally = False

        try:
            async for chunk in stream_generator:
                stream_count += 1
                print(f"[generate_ppt_outline] [STREAM {stream_count}] Got chunk, size={len(chunk) if chunk else 0}",
                      flush=True)

                print(f"[generate_ppt_outline] [STREAM {stream_count}] Before yield", flush=True)
                yield chunk
                print(f"[generate_ppt_outline] [STREAM {stream_count}] After yield", flush=True)

            loop_ended_normally = True
            print(f"[generate_ppt_outline] ✅ Loop ended normally after {stream_count} streams", flush=True)

        except GeneratorExit:
            print(f"[generate_ppt_outline] ⚠️ GeneratorExit after {stream_count} streams", flush=True)
            raise
        except Exception as e:
            print(f"[generate_ppt_outline] ❌ Exception after {stream_count} streams: {e}", flush=True)
            import traceback
            traceback.print_exc()
            raise
        finally:
            print(
                f"[generate_ppt_outline] Finally block - stream_count={stream_count}, ended_normally={loop_ended_normally}",
                flush=True)

    except Exception as e:
        print(f"[generate_ppt_outline] ❌ Outer exception: {e}", flush=True)
        import traceback
        traceback.print_exc()
        yield handle_llm_client_exceptions(e)
    finally:
        print(f"[generate_ppt_outline] === END ===\n", flush=True)