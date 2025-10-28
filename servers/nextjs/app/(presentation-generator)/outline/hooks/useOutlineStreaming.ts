import { useEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { toast } from "sonner";
import { setOutlines } from "@/store/slices/presentationGeneration";
import { jsonrepair } from "jsonrepair";
import { RootState } from "@/store/store";

export const useOutlineStreaming = (presentationId: string | null) => {
  const dispatch = useDispatch();
  const { outlines } = useSelector((state: RootState) => state.presentationGeneration);
  const [isStreaming, setIsStreaming] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [activeSlideIndex, setActiveSlideIndex] = useState<number | null>(null);
  const [highestActiveIndex, setHighestActiveIndex] = useState<number>(-1);
  const prevSlidesRef = useRef<{ content: string }[]>([]);
  const activeIndexRef = useRef<number>(-1);
  const highestIndexRef = useRef<number>(-1);
  const hasReceivedDataRef = useRef(false);

  // ✅ 新增：追踪已初始化的 presentationId
  const hasInitializedRef = useRef<string | null>(null);

  useEffect(() => {
    console.log("🔍 [DEBUG] Effect triggered", {
      presentationId,
      outlinesLength: outlines.length,
      hasInitialized: hasInitializedRef.current,
      isMatch: hasInitializedRef.current === presentationId
    });

    if (!presentationId) {
      console.log("🔍 [DEBUG] Early return: no presentationId");
      return;
    }

    // ✅ 如果已经为这个 presentationId 初始化过，跳过
    if (hasInitializedRef.current === presentationId) {
      console.log("🔍 [DEBUG] Early return: already initialized for this presentation");
      return;
    }

    // ✅ 标记为已初始化
    hasInitializedRef.current = presentationId;
    console.log("✅ [DEBUG] Marked as initialized:", presentationId);

    let eventSource: EventSource | null = null;
    let accumulatedChunks = "";
    let isCompleted = false;
    hasReceivedDataRef.current = false;

    const cleanup = () => {
      if (eventSource) {
        console.log("🧹 [DEBUG] Cleaning up EventSource");
        eventSource.close();
        eventSource = null;
      }
    };

    const resetState = () => {
      setIsStreaming(false);
      setIsLoading(false);
      setActiveSlideIndex(null);
      setHighestActiveIndex(-1);
      activeIndexRef.current = -1;
      highestIndexRef.current = -1;
    };

    const handleMessage = (rawData: string) => {
      try {
        hasReceivedDataRef.current = true;
        console.log("📨 [DEBUG] Message received:", rawData.substring(0, 150));

        const data = JSON.parse(rawData);
        console.log("📦 [DEBUG] Data type:", data.type);

        switch (data.type) {
          case "status":
            console.log("ℹ️ [DEBUG] Status:", data.status);
            // Status messages don't affect loading state
            break;

          case "chunk":
            console.log("📝 [DEBUG] Chunk received");
            accumulatedChunks += data.chunk;

            try {
              const repairedJson = jsonrepair(accumulatedChunks);
              const partialData = JSON.parse(repairedJson);

              if (partialData.slides) {
                const nextSlides: { content: string }[] = partialData.slides || [];

                try {
                  const prev = prevSlidesRef.current || [];
                  let changedIndex: number | null = null;
                  const maxLen = Math.max(prev.length, nextSlides.length);

                  for (let i = 0; i < maxLen; i++) {
                    const prevContent = prev[i]?.content;
                    const nextContent = nextSlides[i]?.content;
                    if (nextContent !== prevContent) {
                      changedIndex = i;
                    }
                  }

                  const prevActive = activeIndexRef.current;
                  let nextActive = changedIndex ?? prevActive;
                  if (nextActive < prevActive) {
                    nextActive = prevActive;
                  }

                  activeIndexRef.current = nextActive;
                  setActiveSlideIndex(nextActive);

                  if (nextActive > highestIndexRef.current) {
                    highestIndexRef.current = nextActive;
                    setHighestActiveIndex(nextActive);
                  }
                } catch (e) {
                  console.error("⚠️ [DEBUG] Error tracking slides:", e);
                }

                prevSlidesRef.current = nextSlides;
                dispatch(setOutlines(nextSlides));
                setIsLoading(false);
              }
            } catch (error) {
              // JSON not complete yet
              console.log("⏳ [DEBUG] Waiting for complete JSON");
            }
            break;

          case "complete":
            console.log("🎉 [DEBUG] Stream complete");
            isCompleted = true;
            try {
              const outlinesData: { content: string }[] = data.presentation.outlines.slides;
              dispatch(setOutlines(outlinesData));
              prevSlidesRef.current = outlinesData;
            } catch (error) {
              console.error("❌ [DEBUG] Error parsing complete data:", error);
              toast.error("Failed to parse presentation data");
            }
            resetState();
            cleanup();
            break;

          case "closing":
            console.log("🔚 [DEBUG] Stream closing");
            isCompleted = true;
            resetState();
            cleanup();
            break;

          case "error":
            console.error("❌ [DEBUG] Server error:", data.detail);
            isCompleted = true;
            resetState();
            cleanup();
            toast.error("Error in outline streaming", {
              description: data.detail || "Failed to generate outlines",
            });
            break;

          default:
            console.warn("⚠️ [DEBUG] Unknown type:", data.type);
        }
      } catch (parseError) {
        console.error("❌ [DEBUG] Parse error:", parseError);
      }
    };

    const initializeStream = () => {
      console.log("🚀 [DEBUG] Initializing stream");
      setIsStreaming(true);
      setIsLoading(true);

      try {
        const url = `/api/v1/ppt/outlines/stream/${presentationId}`;
        console.log("🔗 [DEBUG] URL:", url);

        eventSource = new EventSource(url);

        eventSource.onopen = () => {
          console.log("🟢 [DEBUG] Connection opened, readyState:", eventSource?.readyState);
        };

        // Listen to BOTH events
        eventSource.addEventListener("response", (event) => {
          console.log("📨 [DEBUG] 'response' event");
          handleMessage(event.data);
        });

        eventSource.onmessage = (event) => {
          console.log("📨 [DEBUG] 'message' event");
          handleMessage(event.data);
        };

        eventSource.onerror = (error) => {
          console.error("❌ [DEBUG] EventSource error:", {
            readyState: eventSource?.readyState,
            hasReceivedData: hasReceivedDataRef.current,
            isCompleted,
            error
          });

          // If we haven't received any data and it's not completed, show error
          if (!hasReceivedDataRef.current && !isCompleted) {
            toast.error("Failed to connect to the server. Please try again.");
          }

          // Don't reset state if we've already completed successfully
          if (!isCompleted) {
            resetState();
          }

          cleanup();
        };

      } catch (error) {
        console.error("❌ [DEBUG] Initialization error:", error);
        resetState();
        toast.error("Failed to initialize connection");
      }
    };

    initializeStream();

    return cleanup;
  }, [presentationId, dispatch]); // ✅ 移除了 outlines.length 依赖

  return { isStreaming, isLoading, activeSlideIndex, highestActiveIndex };
};