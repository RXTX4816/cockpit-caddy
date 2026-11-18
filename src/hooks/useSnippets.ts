import { useState, useEffect, useMemo, useCallback } from "react";
import { useAutoRefresh } from "@rxtx4816/cockpit-plugin-base-react";
import { i18n } from "@rxtx4816/cockpit-plugin-base-react/i18n";
import {
  readSnippetsConf, writeSnippetsConfValidated, readCaddyfile, readProxyConf, ensureConfDImported, reloadCaddy,
  parseSnippets, snippetsToConf, snippetUsage, mergeSnippetLists, CaddyfileError,
} from "../api";
import type { SnippetDef } from "../api";

/**
 * The snippets on the Settings tab (#288): the plugin's own (editable) and the ones hand-written
 * in the main Caddyfile (read-only), plus which conf.d sites import each one.
 */
export function useSnippets() {
  const [pluginConf, setPluginConf] = useState("");
  const [mainCaddyfile, setMainCaddyfile] = useState("");
  const [proxyConf, setProxyConf] = useState("");
  const [loaded, setLoaded] = useState(false);

  const sync = useCallback(() => {
    void Promise.all([readSnippetsConf(), readCaddyfile(), readProxyConf()])
      .then(([snippetsConf, main, conf]) => {
        setPluginConf(snippetsConf);
        setMainCaddyfile(main ?? "");
        setProxyConf(conf);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useEffect(sync, [sync]);
  useAutoRefresh(sync, 3000);

  const snippets = useMemo(
    () => mergeSnippetLists(parseSnippets(pluginConf, "plugin"), parseSnippets(mainCaddyfile, "caddyfile")),
    [pluginConf, mainCaddyfile],
  );
  const usage = useMemo(() => snippetUsage(proxyConf), [proxyConf]);

  /** Writes the new list, validates the whole Caddyfile (restoring the file on an error), reloads. */
  const write = useCallback(async (next: Pick<SnippetDef, "name" | "body">[]) => {
    await ensureConfDImported();
    const content = snippetsToConf(next);
    await writeSnippetsConfValidated(content);
    setPluginConf(content);
    await reloadCaddy();
  }, []);

  /** Adds a snippet, or replaces `previousName` (which may rename it while no site imports it). */
  const save = useCallback(async (snippet: Pick<SnippetDef, "name" | "body">, previousName?: string) => {
    const current = parseSnippets(await readSnippetsConf(), "plugin");
    if (snippet.name !== previousName && snippets.some(s => s.name === snippet.name)) {
      throw new CaddyfileError(i18n.t("snippets.error_name_taken", { name: snippet.name }));
    }
    if (previousName && previousName !== snippet.name && usage[previousName]?.length) {
      throw new CaddyfileError(i18n.t("snippets.error_rename_in_use", { name: previousName, sites: usage[previousName].join(", ") }));
    }
    const index = previousName ? current.findIndex(s => s.name === previousName) : -1;
    const next = index >= 0 ? current.map((s, i) => (i === index ? snippet : s)) : [...current, snippet];
    await write(next);
  }, [snippets, usage, write]);

  /** Deletes a plugin snippet; refused while a site still imports it. */
  const remove = useCallback(async (name: string) => {
    if (usage[name]?.length) {
      throw new CaddyfileError(i18n.t("snippets.error_in_use", { name, sites: usage[name].join(", ") }));
    }
    await write(parseSnippets(await readSnippetsConf(), "plugin").filter(s => s.name !== name));
  }, [usage, write]);

  return { snippets, usage, loaded, save, remove };
}
