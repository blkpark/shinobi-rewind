import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";

export type Language = "ko" | "en";

const storageKey = "shinobi-rewind:language";
type LanguageContextValue = { language: Language; setLanguage: Dispatch<SetStateAction<Language>>; text: (korean: string, english: string) => string };

const LanguageContext = createContext<LanguageContextValue>({
  language: "ko" as Language,
  setLanguage: () => undefined,
  text: (korean: string, _english: string) => korean,
});

function initialLanguage(): Language {
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (saved === "ko" || saved === "en") return saved;
  } catch { /* storage is optional */ }
  return navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en";
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(initialLanguage);
  useEffect(() => {
    document.documentElement.lang = language;
    try { window.localStorage.setItem(storageKey, language); } catch { /* storage is optional */ }
  }, [language]);
  const value = useMemo(() => ({ language, setLanguage, text: (korean: string, english: string) => language === "ko" ? korean : english }), [language]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export const useLanguage = () => useContext(LanguageContext);

const capabilityMessages: Record<string, string> = {
  "카메라 상태 확인 중": "Checking camera status",
  "카메라 상태 확인 불가": "Camera status unavailable",
  "모션 데이터 확인 불가": "Motion data unavailable",
  "모션 데이터 사용 불가 · detector off": "Motion data unavailable · detector off",
  "모션 데이터 사용 불가 · 카메라를 선택하세요": "Motion data unavailable · select a camera",
  "모션 데이터 사용 불가 · 이벤트 소스 확인 필요": "Motion data unavailable · check the event source",
  "모션 이벤트 사용 가능": "Motion events available",
  "실시간 스트림 확인 중": "Checking live streams",
  "실시간 스트림 정보를 불러오지 못했습니다.": "Could not load live stream information.",
  "실시간 스트림이 구성되지 않았습니다.": "Live streaming is not configured.",
  "HLS 프록시 구성됨 · 스트림 권한은 카메라 연결 시 확인": "HLS proxy configured · stream permission is checked when connecting",
};

export function localizeMessage(message: string, language: Language) {
  return language === "ko" ? message : capabilityMessages[message] || message;
}
