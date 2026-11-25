import { useState } from "react";
import {
  Button,
  DataList,
  DataListCell,
  DataListItem,
  DataListItemCells,
  DataListItemRow,
  DataListAction,
  Form,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  TextArea,
  TextInput,
  Title,
  Tooltip,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { isValidSnippetName, snippetPreview } from "../api";
import type { SnippetDef } from "../api";
import { useSnippets } from "../hooks/useSnippets";
import { Notice } from "./Notice";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Settings tab → Snippets (#288): reusable `(name) { ... }` blocks that sites `import`. */
export function SnippetsSection() {
  const { t } = useTranslation();
  const { snippets, usage, save, remove } = useSnippets();
  const [editing, setEditing] = useState<SnippetDef | "new" | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirmDelete(name: string) {
    setBusy(true);
    setError(null);
    try {
      await remove(name);
      setDeleting(null);
    } catch (e) {
      setError(errorText(e));
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label={t("snippets.title")} style={{ maxWidth: "56rem", marginTop: "var(--pf-t--global--spacer--xl)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "var(--pf-t--global--spacer--sm)" }}>
        <Title headingLevel="h3">{t("snippets.title")}</Title>
        <Button variant="secondary" size="sm" onClick={() => { setError(null); setEditing("new"); }}>
          {t("snippets.add")}
        </Button>
      </div>
      <HelperText style={{ marginBottom: "var(--pf-t--global--spacer--sm)" }}>
        <HelperTextItem>{t("snippets.intro")}</HelperTextItem>
      </HelperText>
      {error && <Notice variant="danger" title={error} style={{ marginBottom: "var(--pf-t--global--spacer--sm)" }} />}
      {snippets.length === 0 ? (
        <p style={{ color: "var(--pf-t--global--text--color--subtle)" }}>{t("snippets.empty")}</p>
      ) : (
        <DataList aria-label={t("snippets.title")} isCompact>
          {snippets.map(s => {
            const users = usage[s.name] ?? [];
            return (
              <DataListItem key={s.name} aria-labelledby={`snippet-${s.name}`}>
                <DataListItemRow>
                  <DataListItemCells
                    dataListCells={[
                      <DataListCell key="name" width={2}>
                        <code id={`snippet-${s.name}`}>{s.name}</code>
                        {s.source === "caddyfile" && (
                          <Label isCompact color="grey" style={{ marginLeft: "0.5rem" }}>{t("snippets.from_caddyfile")}</Label>
                        )}
                      </DataListCell>,
                      <DataListCell key="preview" width={3}>
                        <code style={{ color: "var(--pf-t--global--text--color--subtle)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>
                          {snippetPreview(s.body)}
                        </code>
                      </DataListCell>,
                      <DataListCell key="used" width={2}>
                        {users.length ? t("snippets.used_by", { sites: users.join(", ") }) : t("snippets.unused")}
                      </DataListCell>,
                    ]}
                  />
                  {s.source === "plugin" && (
                    <DataListAction aria-label={t("snippets.actions", { name: s.name })} aria-labelledby={`snippet-${s.name}`} id={`snippet-actions-${s.name}`}>
                      {deleting === s.name ? (
                        <>
                          <Button variant="danger" size="sm" isLoading={busy} isDisabled={busy} onClick={() => void confirmDelete(s.name)}>
                            {t("snippets.confirm_delete")}
                          </Button>
                          <Button variant="link" size="sm" onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
                        </>
                      ) : (
                        <>
                          <Button variant="secondary" size="sm" onClick={() => { setError(null); setEditing(s); }} aria-label={t("snippets.edit_named", { name: s.name })}>
                            {t("common.edit")}
                          </Button>
                          <Tooltip content={users.length ? t("snippets.error_in_use", { name: s.name, sites: users.join(", ") }) : t("common.delete")}>
                            <Button variant="plain" isDanger size="sm" onClick={() => { setError(null); setDeleting(s.name); }} aria-label={t("snippets.delete_named", { name: s.name })}>
                              {t("common.delete")}
                            </Button>
                          </Tooltip>
                        </>
                      )}
                    </DataListAction>
                  )}
                </DataListItemRow>
              </DataListItem>
            );
          })}
        </DataList>
      )}
      {editing && (
        <SnippetDialog
          snippet={editing === "new" ? undefined : editing}
          takenNames={snippets.map(s => s.name).filter(n => editing === "new" || n !== editing.name)}
          onSave={async (next, previous) => { await save(next, previous); setEditing(null); }}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

interface DialogProps {
  snippet?: SnippetDef;
  takenNames: string[];
  onSave: (snippet: Pick<SnippetDef, "name" | "body">, previousName?: string) => Promise<void>;
  onClose: () => void;
}

/** Name + raw Caddyfile body. Saving validates the whole config, so a broken body is refused. */
export function SnippetDialog({ snippet, takenNames, onSave, onClose }: DialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(snippet?.name ?? "");
  const [body, setBody] = useState(snippet?.body ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const nameError = !trimmed ? null
    : !isValidSnippetName(trimmed) ? t("snippets.name_invalid")
    : takenNames.includes(trimmed) ? t("snippets.error_name_taken", { name: trimmed })
    : null;
  const canSave = !!trimmed && !nameError && !!body.trim() && !saving;

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: trimmed, body }, snippet?.name);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} variant="medium" aria-labelledby="snippet-dialog-title">
      <ModalHeader title={snippet ? t("snippets.edit_title") : t("snippets.add_title")} labelId="snippet-dialog-title" />
      <ModalBody>
        {error && <Notice variant="danger" title={t("snippets.save_failed")} style={{ marginBottom: "1rem" }}>{error}</Notice>}
        <Form onSubmit={e => { e.preventDefault(); if (canSave) void handleSave(); }}>
          <FormGroup label={t("snippets.name_label")} fieldId="snippet-name" isRequired>
            <TextInput
              id="snippet-name"
              value={name}
              onChange={(_e, v) => setName(v)}
              validated={nameError ? "error" : "default"}
              isRequired
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem variant={nameError ? "error" : "default"}>{nameError ?? t("snippets.name_help")}</HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>
          <FormGroup label={t("snippets.body_label")} fieldId="snippet-body" isRequired>
            <TextArea
              id="snippet-body"
              value={body}
              onChange={(_e, v) => setBody(v)}
              rows={10}
              resizeOrientation="vertical"
              style={{ fontFamily: "var(--pf-t--global--font--family--mono)" }}
              isRequired
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>{t("snippets.body_help")}</HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={() => void handleSave()} isDisabled={!canSave} isLoading={saving}>
          {t("common.save")}
        </Button>
        <Button variant="link" onClick={onClose}>{t("common.cancel")}</Button>
      </ModalFooter>
    </Modal>
  );
}
