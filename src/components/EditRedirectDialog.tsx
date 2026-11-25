import { useState } from "react";
import {
  Button,
  Form,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { useConfirmAction } from "@rxtx4816/cockpit-plugin-base-react";
import { useToast } from "@rxtx4816/cockpit-plugin-base-react/components";
import { CaddyApiError } from "../api";
import type { ProxyEntry } from "../api";
import { SnippetImportsField } from "./SnippetImportsField";
import { ProxyTabs } from "./ProxyTabs";
import { firstTabWithError, type ProxyTabKey } from "./proxyDialogParts";
import { proxyTabStateFlags, proxyTabStateFromEntry, useProxyTabState } from "./proxyTabState";
import { Notice } from "./Notice";

const REDIRECT_CODES = [301, 302, 307, 308] as const;

interface Props {
  proxy: ProxyEntry;
  existingPorts: number[];
  onSave: (entry: ProxyEntry) => Promise<void>;
  onClose: () => void;
}

export function EditRedirectDialog({ proxy, existingPorts, onSave, onClose }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirmAction = useConfirmAction();

  const [to, setTo] = useState(proxy.redirect?.to ?? "");
  const [code, setCode] = useState<301 | 302 | 307 | 308>(proxy.redirect?.code ?? 308);
  const [label, setLabel] = useState(proxy.label ?? "");
  const [tabState, updateTabState] = useProxyTabState(proxyTabStateFromEntry(proxy));
  const [activeTab, setActiveTab] = useState<ProxyTabKey>("general");
  const [imports, setImports] = useState<string[] | undefined>(proxy.imports);
  const [toErr, setToErr] = useState<string | null>(null);

  void existingPorts; // port is not editable when editing

  function validate(): boolean {
    if (!to.trim()) { setToErr(t("add_redirect.validation_to_required")); return false; }
    setToErr(null);
    return true;
  }

  function handleSave() {
    const errorTab = firstTabWithError(proxyTabStateFlags(tabState, !validate(), "route").hasError);
    if (errorTab) {
      setActiveTab(errorTab);
      return;
    }
    confirmAction.confirm();
  }

  const isLocked = confirmAction.step !== "idle";
  const isSaving = confirmAction.step === "submitting";

  return (
    <Modal isOpen onClose={onClose} aria-label={t("edit_redirect.aria_label")} variant="medium">
      <ModalHeader title={t("edit_redirect.title", { port: proxy.externalPort })} />
      <ModalBody>
        {isLocked && (
          <Notice
            variant="warning"
            title={t("edit_redirect.confirm_body", { port: proxy.externalPort })}
          />
        )}

        <ProxyTabs
          state={tabState}
          onChange={updateTabState}
          active={activeTab}
          onSelect={setActiveTab}
          isDisabled={isLocked}
          idPrefix="edit-redirect"
          layout="route"
          generalHasError={!!(toErr)}
          general={
            <Form isHorizontal>
              <FormGroup label={t("add_proxy.field_label")} fieldId="edit-redirect-label">
                <TextInput
                  id="edit-redirect-label"
                  value={label}
                  onChange={(_e, v) => setLabel(v)}
                  placeholder={t("common.example_value", { value: t("add_proxy.field_label_placeholder") })}
                  isDisabled={isLocked}
                />
              </FormGroup>

              <FormGroup label={t("add_redirect.field_to_url")} fieldId="edit-redirect-to" isRequired>
                <TextInput
                  id="edit-redirect-to"
                  value={to}
                  onChange={(_e, v) => { setTo(v); setToErr(null); }}
                  placeholder={t("common.example_value", { value: "https://{host}{uri}" })}
                  isDisabled={isLocked}
                  validated={toErr ? "error" : "default"}
                />
                {toErr ? (
                  <FormHelperText>
                    <HelperText><HelperTextItem variant="error">{toErr}</HelperTextItem></HelperText>
                  </FormHelperText>
                ) : (
                  <FormHelperText>
                    <HelperText><HelperTextItem>{t("add_redirect.field_to_url_help")}</HelperTextItem></HelperText>
                  </FormHelperText>
                )}
              </FormGroup>

              <FormGroup label={t("add_redirect.field_code")} fieldId="edit-redirect-code" isRequired>
                <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                  {REDIRECT_CODES.map(c => (
                    <Button
                      key={c}
                      variant={code === c ? "primary" : "secondary"}
                      size="sm"
                      onClick={() => setCode(c)}
                      isDisabled={isLocked}
                    >
                      {t(`add_redirect.code_${c}`)}
                    </Button>
                  ))}
                </div>
              </FormGroup>
              <SnippetImportsField value={imports} onChange={setImports} snippetSettings={proxy.snippetSettings} isDisabled={isLocked} />
            </Form>
          }
        />

        {confirmAction.error && (
          <Notice variant="danger" title={confirmAction.error} />
        )}
      </ModalBody>
      <ModalFooter>
        {isLocked ? (
          <>
            <Button
              variant="primary"
              isLoading={isSaving}
              isDisabled={isSaving}
              onClick={() => void confirmAction.submit(async () => {
                const updated: ProxyEntry = {
                  ...proxy,
                  label: label.trim() || undefined,
                  redirect: { to: to.trim(), code },
                  matchers: tabState.matchers ?? undefined,
                  imports,
                  handlePath: tabState.handlePath || undefined,
                };
                try {
                  await onSave(updated);
                } catch (e) {
                  if (e instanceof CaddyApiError) {
                    onClose();
                    toast.error(t("proxies.api_error_edit_title"), e.message);
                    return;
                  }
                  throw e;
                }
                toast.success(t("toast.proxy_saved", { port: proxy.externalPort }));
                onClose();
              })}
            >
              {t("service.confirm_action")}
            </Button>
            <Button variant="link" onClick={confirmAction.cancel} isDisabled={isSaving}>{t("common.back")}</Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={handleSave}>{t("edit_redirect.save_button")}</Button>
            <Button variant="link" onClick={onClose}>{t("common.cancel")}</Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
