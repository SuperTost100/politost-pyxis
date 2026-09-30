import { createContext, useContext } from "react";
import type { Appearance, ThemeSource } from "@shared/bridge";

type AppState = {
  appearance: Appearance;
  setTheme: (source: ThemeSource) => void;
};

export const AppStateContext = createContext<AppState | null>(null);

export function useAppState(): AppState {
  const value = useContext(AppStateContext);
  if (!value) throw new Error("missing-app-state");
  return value;
}
