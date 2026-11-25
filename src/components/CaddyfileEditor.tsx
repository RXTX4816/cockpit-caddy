import { useState, useEffect } from "react";
import {
  Button,
  Label,
  Spinner,
  Stack,
  StackItem,
  ToggleGroup,
  ToggleGroupItem,
  Toolbar,
  ToolbarContent,
  ToolbarGroup,
  ToolbarItem,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { CodeEditor, useToast } from "@rxtx4816/cockpit-plugin-base-react/components";
import { useCaddyfile } from "../hooks/useCaddyfile";
import { caddyfile } from "./caddyfileLanguage";
import { listConfDFiles, validateCaddyfile, reloadCaddy, applyCurrentCaddyfileViaApi, isCaddyManaged } from "../api";
import { Notice } from "./Notice";

const MAIN_PATH = "/etc/caddy/Caddyfile";

/** Module-level so the editor isn't rebuilt on every render (the extensions are effect deps). */
const CADDYFILE_EXTENSIONS = [caddyfile()];
const PLAIN_EXTENSIONS = [[]]; // same length as CADDYFILE_EXTENSIONS: the base spreads them into effect deps

/** conf.d can hold other files (e.g. the legacy servers JSON); only Caddyfiles get highlighting (#283). */
function extensionsFor(path: string) {
  return /\.json$/i.test(path) ? PLAIN_EXTENSIONS : CADDYFILE_EXTENSIONS;
}

interface FileEntry {
  path: string;
  label: string;
}

interface Props {
  /** True when Caddy is only reachable via the Admin API (no local systemd unit) — e.g. running in a container. */
  unmanaged?: boolean;
}

export function CaddyfileEditor({ unmanaged = false }: Props) {
  const { t } = useTranslation();
  const toast = useToast();

  const [files, setFiles] = useState<FileEntry[]>([{ path: MAIN_PATH, label: "Caddyfile" }]);
  const [selectedPath, setSelectedPath] = useState(MAIN_PATH);

  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [baselineContent, setBaselineContent] = useState("");

  const [validating, setValidating] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);

  const { diskContent, loading, error, saving, save } = useCaddyfile(selectedPath);

  // Poll conf.d every 3 s to pick up new or deleted files
  useEffect(() => {
    const scan = () => {
      listConfDFiles()
        .then(paths => {
          const confD = paths.map(p => ({
            path: p,
            label: `conf.d/${p.split("/").pop() ?? p}`,
          }));
          const next = [{ path: MAIN_PATH, label: "Caddyfile" }, ...confD];
          setFiles(prev => {
            const same = prev.length === next.length && prev.every((f, i) => f.path === next[i].path);
            return same ? prev : next;
          });
        })
        .catch(() => {});
    };
    scan();
    const id = setInterval(scan, 3000);
    return () => clearInterval(id);
  }, []);

  // If the selected file disappears (e.g. deleted externally), fall back to main
  useEffect(() => {
    if (selectedPath !== MAIN_PATH && !files.some(f => f.path === selectedPath)) {
      setEditMode(false);
      setSelectedPath(MAIN_PATH);
    }
  }, [files, selectedPath]);

  function enterEdit() {
    if (diskContent === null) return;
    setDraft(diskContent);
    setBaselineContent(diskContent);
    setEditMode(true);
    setSaveErr(null);
    setNeedsReload(false);
    setReloadError(null);
  }

  function cancelEdit() {
    setEditMode(false);
  }

  function switchFile(entry: FileEntry) {
    setEditMode(false);
    setSelectedPath(entry.path);
    setSaveErr(null);
    setNeedsReload(false);
    setReloadError(null);
  }

  async function handleSave() {
    setSaveErr(null);
    const managed = isCaddyManaged();
    if (selectedPath === MAIN_PATH && managed) {
      setValidating(true);
      try {
        await validateCaddyfile(draft);
      } catch (e) {
        setSaveErr(e instanceof Error ? e.message : String(e));
        setValidating(false);
        return;
      }
      setValidating(false);
    }
    try {
      await save(draft);
      setBaselineContent(draft);
      setEditMode(false);
      if (selectedPath === MAIN_PATH && !managed) {
        // No local caddy binary/systemd unit to validate/reload with — the Admin
        // API's /load endpoint validates and applies atomically in one step.
        // Rebuilds from disk (main + conf.d inlined) rather than posting `draft`
        // directly, since conf.d must be inlined — see applyCurrentCaddyfileViaApi.
        try {
          await applyCurrentCaddyfileViaApi();
        } catch (e) {
          setSaveErr(e instanceof Error ? e.message : String(e));
          setNeedsReload(true); // let the user retry via the Reload button
        }
      } else {
        setNeedsReload(true);
      }
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleReload() {
    setReloading(true);
    setReloadError(null);
    try {
      await reloadCaddy();
      setNeedsReload(false);
      toast.success(t("caddyfile.reloaded"));
    } catch (e) {
      setReloadError(e instanceof Error ? e.message : String(e));
    } finally {
      setReloading(false);
    }
  }

  const diskChangedWhileEditing =
    editMode && diskContent !== null && diskContent !== baselineContent;
  const isBusy = saving || validating || reloading;
  const isManagedByPlugin = selectedPath.endsWith("/cockpit-caddy.conf");

  if (loading) return <Spinner />;

  return (
    <Stack hasGutter>
      {error && (
        <StackItem>
          <Notice isInline={false} variant="danger" title={t("caddyfile.load_failed")}>{error}</Notice>
        </StackItem>
      )}
      {saveErr && (
        <StackItem>
          <Notice isInline={false} variant="danger" title={t("caddyfile.save_failed")}>{saveErr}</Notice>
        </StackItem>
      )}
      {reloadError && (
        <StackItem>
          <Notice isInline={false} variant="danger" title={t("service.reload_failed")}>{reloadError}</Notice>
        </StackItem>
      )}
      {needsReload && (
        <StackItem>
          <Notice isInline={false}
            variant="warning"
            title={t("caddyfile.saved_needs_reload")}
            actionLinks={
              <Button variant="warning" size="sm" isLoading={reloading} isDisabled={reloading} onClick={handleReload}>
                {t("service.reload")}
              </Button>
            }
          />
        </StackItem>
      )}
      {isManagedByPlugin && (
        <StackItem>
          <Notice variant="info" title={t("caddyfile.managed_file")} />
        </StackItem>
      )}
      {unmanaged && (
        <StackItem>
          <Notice variant="info" title={t("caddyfile.unmanaged_note")} />
        </StackItem>
      )}

      <StackItem>
        <Toolbar>
          <ToolbarContent>
            <ToolbarItem>
              <ToggleGroup isCompact aria-label={t("caddyfile.file_switcher")}>
                {files.map(f => (
                  <ToggleGroupItem
                    key={f.path}
                    text={<code style={{ fontSize: "0.8rem" }}>{f.label}</code>}
                    isSelected={f.path === selectedPath}
                    onChange={() => switchFile(f)}
                  />
                ))}
              </ToggleGroup>
            </ToolbarItem>

            <ToolbarGroup align={{ default: "alignEnd" }}>
              {diskChangedWhileEditing && (
                <ToolbarItem>
                  <Label color="orange" isCompact>{t("caddyfile.changed_on_disk")}</Label>
                </ToolbarItem>
              )}
              {editMode ? (
                <>
                  <ToolbarItem>
                    <Button variant="primary" size="sm" isLoading={isBusy} isDisabled={isBusy} onClick={handleSave}>
                      {t("common.save")}
                    </Button>
                  </ToolbarItem>
                  <ToolbarItem>
                    <Button variant="link" size="sm" isDisabled={isBusy} onClick={cancelEdit}>
                      {t("common.cancel")}
                    </Button>
                  </ToolbarItem>
                </>
              ) : (
                <ToolbarItem>
                  <Button variant="secondary" size="sm" isDisabled={diskContent === null} onClick={enterEdit}>
                    {t("common.edit")}
                  </Button>
                </ToolbarItem>
              )}
            </ToolbarGroup>
          </ToolbarContent>
        </Toolbar>
      </StackItem>

      <StackItem isFilled>
        {diskContent !== null && (
          editMode ? (
            <div style={{ minHeight: "25rem" }}>
              <CodeEditor content={draft} onChange={setDraft} extensions={extensionsFor(selectedPath)} />
            </div>
          ) : (
            diskContent ? (
              <div style={{ minHeight: "20rem" }} data-testid="caddyfile-viewer">
                <CodeEditor content={diskContent} readOnly extensions={extensionsFor(selectedPath)} />
              </div>
            ) : (
              <em style={{ color: "var(--pf-v6-global--Color--200)" }}>
                {t("caddyfile.empty")}
              </em>
            )
          )
        )}
      </StackItem>
    </Stack>
  );
}
