import { useState, useEffect, useCallback } from "react";
import {
  Alert,
  Button,
  Checkbox,
  CodeBlock,
  CodeBlockCode,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Spinner,
  Split,
  SplitItem,
  Title,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { readCaddyfile, readProxyConf, scanConfigIssues, runConfigFixes, reloadService, CaddyfileError } from "../api";
import type { ConfigFinding } from "../api";

interface Props {
  onClose: () => void;
}

/**
 * "Check Config" maintenance action — scans the Caddyfile + conf.d for known-stale
 * shapes left over by older versions of this plugin (or hand-editing), each traced to
 * a specific Caddy reload failure. Shows every finding with a before/after preview and
 * an explanation, and lets the user pick exactly which fixes to apply.
 */
export function ConfigCheckModal({ onClose }: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [findings, setFindings] = useState<ConfigFinding[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [reloadOk, setReloadOk] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);

  const scan = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    Promise.all([readCaddyfile(), readProxyConf()])
      .then(([main, proxyConf]) => {
        const found = scanConfigIssues(main ?? "", proxyConf);
        setFindings(found);
        setSelected(new Set(found.map(f => f.id)));
      })
      .catch(e => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { scan(); }, [scan]);

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleApply() {
    setApplying(true);
    setApplyError(null);
    try {
      await runConfigFixes(selected);
      setApplied(true);
      scan();
    } catch (e) {
      if (e instanceof CaddyfileError) setApplyError(e.message);
      else setApplyError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }

  async function handleReload() {
    setReloading(true);
    setReloadError(null);
    try {
      await reloadService("caddy");
      setReloadOk(true);
      setTimeout(() => setReloadOk(false), 4000);
    } catch (e) {
      setReloadError(e instanceof Error ? e.message : String(e));
    } finally {
      setReloading(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} aria-label={t("config_check.title")} variant="large">
      <ModalHeader title={t("config_check.title")} />
      <ModalBody>
        <Alert variant="info" isInline title={t("config_check.intro")} style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }} />

        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "var(--pf-v6-global--spacer--md)" }}>
          <Button variant="secondary" size="sm" isLoading={reloading} isDisabled={reloading} onClick={() => void handleReload()}>
            {t("service.reload")}
          </Button>
          <span style={{ color: "var(--pf-t--global--text--color--subtle)", fontSize: "0.85em" }}>{t("config_check.reload_hint")}</span>
        </div>
        {reloadOk && (
          <Alert variant="success" isInline title={t("caddyfile.reloaded")} style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }} />
        )}
        {reloadError && (
          <Alert variant="danger" isInline title={reloadError} style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }} />
        )}

        {loading && (
          <div style={{ display: "flex", justifyContent: "center", padding: "3rem" }}>
            <Spinner size="lg" />
          </div>
        )}

        {loadError && (
          <Alert variant="danger" isInline title={t("config_check.load_error")}>
            {loadError}
            <Button variant="link" isInline onClick={scan} style={{ marginLeft: "0.5rem" }}>{t("common.retry")}</Button>
          </Alert>
        )}

        {!loading && !loadError && findings.length === 0 && (
          <Alert variant="success" isInline title={t("config_check.no_issues")} />
        )}

        {!loading && !loadError && findings.length > 0 && (
          <>
            {applyError && (
              <Alert variant="danger" isInline title={t("config_check.apply_error")} style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}>
                {applyError}
              </Alert>
            )}
            {applied && (
              <Alert
                variant="success"
                isInline
                title={t("config_check.apply_ok")}
                style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}
                actionLinks={
                  <Button variant="warning" size="sm" isLoading={reloading} isDisabled={reloading} onClick={() => void handleReload()}>
                    {t("service.reload")}
                  </Button>
                }
              />
            )}
            {findings.map(f => (
              <div
                key={f.id}
                style={{
                  border: "1px solid var(--pf-t--global--border--color--default)",
                  borderRadius: "var(--pf-t--global--border--radius--100, 4px)",
                  padding: "0.75rem",
                  marginBottom: "0.75rem",
                }}
              >
                <Checkbox
                  id={`finding-${f.id}`}
                  label={<strong>{f.title}</strong>}
                  isChecked={selected.has(f.id)}
                  onChange={() => toggle(f.id)}
                  isDisabled={applying}
                />
                <p style={{ margin: "0.4rem 0 0.6rem", color: "var(--pf-t--global--text--color--subtle)" }}>{f.explanation}</p>
                <Split hasGutter>
                  <SplitItem isFilled>
                    <Title headingLevel="h6" size="md">{t("config_check.before")}</Title>
                    <CodeBlock>
                      <CodeBlockCode>{f.before}</CodeBlockCode>
                    </CodeBlock>
                  </SplitItem>
                  <SplitItem isFilled>
                    <Title headingLevel="h6" size="md">{t("config_check.after")}</Title>
                    <CodeBlock>
                      <CodeBlockCode>{f.after}</CodeBlockCode>
                    </CodeBlock>
                  </SplitItem>
                </Split>
              </div>
            ))}
          </>
        )}
      </ModalBody>
      <ModalFooter>
        {!loading && !loadError && findings.length > 0 && (
          <Button
            variant="primary"
            isLoading={applying}
            isDisabled={applying || selected.size === 0}
            onClick={() => void handleApply()}
          >
            {t("config_check.apply_button", { count: selected.size })}
          </Button>
        )}
        <Button variant="link" onClick={onClose} isDisabled={applying}>{t("common.close")}</Button>
      </ModalFooter>
    </Modal>
  );
}
