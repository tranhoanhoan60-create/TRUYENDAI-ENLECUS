
import { GoogleGenAI, Type, Modality } from "@google/genai";
import { StoryProject, Character, Scene } from "../types";

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

const fetchWithRetry = async <T>(fn: () => Promise<T>, retries = 5, backoff = 3000): Promise<T> => {
  try {
    return await fn();
  } catch (error: any) {
    const errorMsg = error.message || "";
    const isRetryable = 
      errorMsg.includes('500') || 
      errorMsg.includes('503') || 
      errorMsg.includes('INTERNAL') || 
      errorMsg.includes('overloaded') ||
      errorMsg.includes('UNAVAILABLE');

    if (retries > 0 && isRetryable) {
      console.warn(`API Error (Retryable), retrying in ${backoff}ms... (${retries} attempts left). Error: ${errorMsg}`);
      await delay(backoff);
      return fetchWithRetry(fn, retries - 1, backoff * 2);
    }
    throw error;
  }
};

export const analyzeScript = async (script: string): Promise<StoryProject> => {
  return fetchWithRetry(async () => {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: `NHIỆM VỤ: Phân tích kịch bản và chia thành các phân cảnh chuyên nghiệp.
      
      QUY TẮC NỘI DUNG:
      1. TIÊU ĐỀ: Đặt một tiêu đề thật hấp dẫn, kịch tính hoặc ấm áp (tùy nội dung) để thu hút người xem ngay lập tức.
      2. GIỮ NGUYÊN 100% TỪ NGỮ: Tuyệt đối không thay đổi kịch bản gốc, chỉ thêm dấu câu (., !, ?, ...) để ngắt nghỉ.
      3. GỘP PHÂN CẢNH DÀI: Gom các đoạn cùng bối cảnh để mạch phim liên tục.
      4. LOẠI BỎ NGOẶC: Xóa các chỉ dẫn kỹ thuật như (nhạc nổi lên)...
      5. BÀI HỌC: Tạo scene cuối đúc kết ý nghĩa.
      
      Kịch bản: ${script}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING, description: "A catchy, viral-style title for the story" },
            characters: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  description: { type: Type.STRING },
                  voice: { type: Type.STRING, enum: ['Enceladus', 'Aoede', 'Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr'] }
                },
                required: ["name", "description", "voice"]
              }
            },
            scenes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  content: { type: Type.STRING },
                  visualPrompt: { type: Type.STRING },
                  charactersInScene: { type: Type.ARRAY, items: { type: Type.STRING } }
                },
                required: ["title", "content", "visualPrompt", "charactersInScene"]
              }
            }
          },
          required: ["title", "characters", "scenes"]
        }
      }
    });

    const data = JSON.parse(response.text || '{}');
    return {
      ...data,
      originalScript: script,
      scenes: data.scenes.map((s: any, i: number) => ({ ...s, id: `scene-${i}` }))
    };
  });
};

export const generateSceneImage = async (prompt: string, size: "1K" | "2K" | "4K", isThumbnail: boolean = false): Promise<string> => {
  return fetchWithRetry(async () => {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
    const finalPrompt = isThumbnail 
      ? `Epic movie poster style, high-impact cinematic composition, professional color grading, central focus, masterpiece: ${prompt}`
      : `High-end cinematic movie frame, professional lighting, photorealistic, detailed: ${prompt}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-image-preview',
      contents: { parts: [{ text: finalPrompt }] },
      config: {
        imageConfig: {
          aspectRatio: "16:9",
          imageSize: size
        }
      }
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return `data:image/png;base64,${part.inlineData.data}`;
      }
    }
    throw new Error("No image data returned from Gemini");
  });
};

export const generateSceneSpeech = async (text: string, voice: string): Promise<string> => {
  return fetchWithRetry(async () => {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice }
          }
        }
      }
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) throw new Error("No audio data returned from Gemini");
    return base64Audio;
  });
};

export const decodeBase64Audio = (base64: string): Uint8Array => {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

let currentSource: AudioBufferSourceNode | null = null;
let currentContext: AudioContext | null = null;

export const playAudio = async (base64: string, onEnd: () => void) => {
  if (currentSource) {
    currentSource.stop();
    currentSource = null;
    return false;
  }

  currentContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
  const data = decodeBase64Audio(base64);
  const dataInt16 = new Int16Array(data.buffer);
  const buffer = currentContext.createBuffer(1, dataInt16.length, 24000);
  const channelData = buffer.getChannelData(0);
  for (let i = 0; i < dataInt16.length; i++) {
    channelData[i] = dataInt16[i] / 32768.0;
  }
  
  const source = currentContext.createBufferSource();
  source.buffer = buffer;
  source.connect(currentContext.destination);
  source.onended = () => {
    currentSource = null;
    onEnd();
  };
  
  currentSource = source;
  source.start();
  return true;
};

export const stopAllAudio = () => {
  if (currentSource) {
    currentSource.stop();
    currentSource = null;
  }
};
