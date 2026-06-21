import { useState, useEffect, useCallback } from "react";
import { useAutoRefresh } from "@rxtx4816/cockpit-plugin-base-react";
import { readFile, writeFile } from "../api";

export function useCaddyfile(path: string) {
  const [diskContent, setDiskContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const fetchContent = useCallback(async () => {
    try {
      const text = await readFile(path);
      setDiskContent(text ?? "");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [path]);

  // Initial load — shows spinner, resets when path changes
  useEffect(() => {
    setLoading(true);
    setDiskContent(null);
    setError(null);
    void fetchContent().finally(() => setLoading(false));
  }, [fetchContent]);

  // Silent 1s poll — pauses when tab hidden
  useAutoRefresh(fetchContent, 1000);

  const save = useCallback(async (content: string): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      await writeFile(path, content);
      setDiskContent(content);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSaveError(msg);
      throw new Error(msg);
    } finally {
      setSaving(false);
    }
  }, [path]);

  return { diskContent, loading, error, saving, saveError, save };
}
