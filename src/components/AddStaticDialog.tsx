import { useState } from "react";
import {
  Button,
  Checkbox,
  Form,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  HelperText,
  HelperTextItem,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { FileServerConfig } from "../api";
import { FileServerOptionsFields, fileServerOptionsDraft, fileServerOptionsFromDraft } from "./FileServerOptionsFields";
import { useConfirmAction } from "@rxtx4816/cockpit-plugin-base-react";
import { useToast } from "@rxtx4816/cockpit-plugin-base-react/components";
import { CaddyApiError } from "../api";
import { TlsModeField, hasPublicName, tlsModeToEntry, type TlsMode } from "./TlsModeField";
import type { ProxyEntry } from "../api";
import { SnippetImportsField } from "./SnippetImportsField";
import { ProxyTabs } from "./ProxyTabs";
import { firstTabWithError, type ProxyTabKey } from "./proxyDialogParts";
import { proxyTabStateFlags, proxyTabStateToEntry, useProxyTabState, type ProxyTabState } from "./proxyTabState";

import type { ServerContext } from "./AddRedirectDialog";
import { parseListenPort } from "./AddServerDialog";
import { Notice } from "./Notice";

interface Props {
  existingPorts: number[];
  onAdd: (entry: Omit<ProxyEntry, "id" | "serverKey">) => Promise<void>;
  onClose: () => void;
  initialValues?: { port?: string; root?: string; browse?: boolean; tls?: boolean; compress?: boolean; label?: string; fileServer?: FileServerConfig };
  /** Duplicate: the source's Security / Routing / Logging / Limits settings (#293). */
  initialTabState?: Partial<ProxyTabState>;
  initialImports?: string[];
  servers?: import("../api").ServerDef[];
  initialServerKey?: string;
}

export function AddStaticDialog({ existingPorts, onAdd, onClose, initialValues, initialTabState, initialImports, servers, initialServerKey }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirmAction = useConfirmAction();

  const [port, setPort] = useState(initialValues?.port ?? "");
  const [root, setRoot] = useState(initialValues?.root ?? "");
  const [browse, setBrowse] = useState(initialValues?.browse ?? false);
  const [fsOptions, setFsOptions] = useState(() => fileServerOptionsDraft(initialValues?.fileServer));
  // #246: where the certificate comes from; ACME needs a public name in the site address.
  const [tlsModeChoice, setTlsModeChoice] = useState<TlsMode>((initialValues?.tls ?? true) ? "internal" : "off");
  const publicName = hasPublicName(undefined);
  const tlsMode: TlsMode = tlsModeChoice === "acme" && !publicName ? "internal" : tlsModeChoice;
  const [tlsOnDemand, setTlsOnDemand] = useState(false);
  const [compress, setCompress] = useState(initialValues?.compress ?? false);
  const [label, setLabel] = useState(initialValues?.label ?? "");
  const [tabState, updateTabState] = useProxyTabState(initialTabState);
  const [activeTab, setActiveTab] = useState<ProxyTabKey>("general");
  const [imports, setImports] = useState<string[] | undefined>(initialImports);
  const [selectedServerKey, setSelectedServerKey] = useState(initialServerKey ?? "");
  const [portErr, setPortErr] = useState<string | null>(null);
  const [rootErr, setRootErr] = useState<string | null>(null);

  const selectedServer = servers?.find(s => s.key === selectedServerKey);
  const serverCtx: ServerContext | undefined = selectedServer ? {
    serverKey: selectedServer.key,
    serverName: selectedServer.name,
    port: parseListenPort(selectedServer.listenAddresses[0] ?? ":443"),
  } : undefined;

  function validate(): boolean {
    let ok = true;
    if (!serverCtx) {
      const n = parseInt(port, 10);
      if (!port) { setPortErr(t("add_static.validation_port_required")); ok = false; }
      else if (isNaN(n)) { setPortErr(t("add_static.validation_port_number")); ok = false; }
      else if (n < 1 || n > 65535) { setPortErr(t("add_static.validation_port_range")); ok = false; }
      else if (existingPorts.includes(n)) { setPortErr(t("add_static.validation_port_duplicate", { port: n })); ok = false; }
      else setPortErr(null);
    }

    if (!root.trim()) { setRootErr(t("add_static.validation_root_required")); ok = false; }
    else setRootErr(null);

    return ok;
  }

  function handleAdd() {
    const errorTab = firstTabWithError(proxyTabStateFlags(tabState, !validate(), "site").hasError);
    if (errorTab) {
      setActiveTab(errorTab);
      return;
    }
    confirmAction.confirm();
  }

  const isLocked = confirmAction.step !== "idle";
  const isSaving = confirmAction.step === "submitting";

  return (
    <Modal isOpen onClose={onClose} aria-label={t("add_static.aria_label")} variant="medium">
      <ModalHeader title={t("add_static.title")} />
      <ModalBody>
        {isLocked && (
          <Notice
            variant="warning"
            title={t("add_static.confirm_body", { port: serverCtx ? serverCtx.port : port, root: root.trim() })}
          />
        )}

        <ProxyTabs
          state={tabState}
          onChange={updateTabState}
          active={activeTab}
          onSelect={setActiveTab}
          isDisabled={isLocked}
          idPrefix="add-static"
          layout="site"
          showTls={!serverCtx}
          generalHasError={!!(portErr || rootErr)}
          general={
            <Form isHorizontal>
              <FormGroup label={t("add_proxy.field_label")} fieldId="static-label">
                <TextInput
                  id="static-label"
                  value={label}
                  onChange={(_e, v) => setLabel(v)}
                  placeholder={t("common.example_value", { value: t("add_proxy.field_label_placeholder") })}
                  isDisabled={isLocked}
                />
              </FormGroup>

              {servers && servers.length > 0 && (
                <FormGroup label={t("servers.selector_label")} fieldId="static-server">
                  <FormSelect
                    id="static-server"
                    value={selectedServerKey}
                    onChange={(_e, v) => { setSelectedServerKey(v); setPortErr(null); }}
                    isDisabled={isLocked}
                  >
                    <FormSelectOption value="" label={t("servers.selector_none")} />
                    {servers.map(s => (
                      <FormSelectOption key={s.key} value={s.key} label={`${s.name} (${s.listenAddresses[0] ?? ""})`} />
                    ))}
                  </FormSelect>
                </FormGroup>
              )}

              {serverCtx ? (
                <FormGroup label={t("add_redirect.field_from_port")} fieldId="static-port">
                  <Label isCompact color="blue">{serverCtx.serverName} (:{serverCtx.port})</Label>
                </FormGroup>
              ) : (
                <FormGroup label={t("add_redirect.field_from_port")} fieldId="static-port" isRequired>
                  <TextInput
                    id="static-port"
                    type="number"
                    value={port}
                    onChange={(_e, v) => { setPort(v); setPortErr(null); }}
                    placeholder={t("common.example_value", { value: "8080" })}
                    isDisabled={isLocked}
                    validated={portErr ? "error" : "default"}
                  />
                  {portErr && (
                    <FormHelperText>
                      <HelperText><HelperTextItem variant="error">{portErr}</HelperTextItem></HelperText>
                    </FormHelperText>
                  )}
                </FormGroup>
              )}

              <FormGroup label={t("add_static.field_root")} fieldId="static-root" isRequired>
                <TextInput
                  id="static-root"
                  value={root}
                  onChange={(_e, v) => { setRoot(v); setRootErr(null); }}
                  placeholder={t("common.example_value", { value: t("add_static.field_root_placeholder") })}
                  isDisabled={isLocked}
                  validated={rootErr ? "error" : "default"}
                />
                {rootErr ? (
                  <FormHelperText>
                    <HelperText><HelperTextItem variant="error">{rootErr}</HelperTextItem></HelperText>
                  </FormHelperText>
                ) : (
                  <FormHelperText>
                    <HelperText><HelperTextItem>{t("add_static.field_root_help")}</HelperTextItem></HelperText>
                  </FormHelperText>
                )}
              </FormGroup>

              <FormGroup fieldId="static-browse">
                <Checkbox
                  id="static-browse"
                  label={t("add_static.field_browse")}
                  isChecked={browse}
                  onChange={(_e, v) => setBrowse(v)}
                  isDisabled={isLocked}
                />
              </FormGroup>

              <FileServerOptionsFields idPrefix="static" value={fsOptions} onChange={setFsOptions} isDisabled={isLocked} />

              {!serverCtx && (
                <TlsModeField id="static-tls" value={tlsMode} onChange={setTlsModeChoice} publicName={publicName} isDisabled={isLocked} onDemand={tlsOnDemand} onOnDemandChange={setTlsOnDemand} />
              )}

              <FormGroup fieldId="static-compress">
                <Checkbox
                  id="static-compress"
                  label={t("add_proxy.field_compress_short")}
                  isChecked={compress}
                  onChange={(_e, v) => setCompress(v)}
                  isDisabled={isLocked}
                />
              </FormGroup>
              <SnippetImportsField value={imports} onChange={setImports} isDisabled={isLocked} />
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
                const tabEntry = await proxyTabStateToEntry(tabState);
                try {
                  await onAdd({
                    externalPort: serverCtx ? serverCtx.port : parseInt(port, 10),
                    externalScheme: undefined,
                    externalHost: undefined,
                    targetHost: "localhost",
                    targetPort: 0,
                    targetScheme: "http",
                    ...tlsModeToEntry(tlsMode, undefined),
                    tlsOnDemand: tlsMode !== "off" && tlsOnDemand ? true : undefined,
                    tlsSkipVerify: false,
                    compress: compress || undefined,
                    label: label.trim() || undefined,
                    fileServer: { root: root.trim(), browse: browse || undefined, ...fileServerOptionsFromDraft(fsOptions) },
                    ...tabEntry,
                    imports,
                    namedServerKey: serverCtx?.serverKey,
                  });
                } catch (e) {
                  if (e instanceof CaddyApiError) {
                    onClose();
                    toast.error(t("proxies.api_error_add_title"), e.message);
                    return;
                  }
                  throw e;
                }
                toast.success(t("toast.proxy_added", { port: serverCtx ? serverCtx.port : port }));
                onClose();
              })}
            >
              {t("service.confirm_action")}
            </Button>
            <Button variant="link" onClick={confirmAction.cancel} isDisabled={isSaving}>{t("common.back")}</Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={handleAdd}>{t("add_static.add_button")}</Button>
            <Button variant="link" onClick={onClose}>{t("common.cancel")}</Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
