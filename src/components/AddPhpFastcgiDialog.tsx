import { useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
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
import { PhpTryFilesField } from "./FileServerOptionsFields";
import { useConfirmAction } from "@rxtx4816/cockpit-plugin-base-react";
import { useToast } from "@rxtx4816/cockpit-plugin-base-react/components";
import { CaddyApiError } from "../api";
import { TlsModeField, hasPublicName, tlsModeToEntry, type TlsMode } from "./TlsModeField";
import type { ProxyEntry } from "../api";
import { SnippetImportsField } from "./SnippetImportsField";
import { ProxyTabs } from "./ProxyTabs";
import { firstTabWithError, type ProxyTabKey } from "./proxyDialogParts";
import { proxyTabStateFlags, proxyTabStateToEntry, useProxyTabState, type ProxyTabState } from "./proxyTabState";
import { PhpFastcgiEnvSection, envEntriesToRecord, type EnvEntry } from "./PhpFastcgiEnvSection";

interface Props {
  existingPorts: number[];
  onAdd: (entry: Omit<ProxyEntry, "id" | "serverKey">) => Promise<void>;
  onClose: () => void;
  initialValues?: { port?: string; upstream?: string; root?: string; index?: string; splitPath?: string; tryFiles?: string; tls?: boolean; compress?: boolean; label?: string };
  initialEnv?: EnvEntry[];
  /** Duplicate: the source's Security / Routing / Logging / Limits settings (#293). */
  initialTabState?: Partial<ProxyTabState>;
  initialImports?: string[];
}

export function AddPhpFastcgiDialog({ existingPorts, onAdd, onClose, initialValues, initialEnv, initialTabState, initialImports }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirmAction = useConfirmAction();

  const [port, setPort] = useState(initialValues?.port ?? "");
  const [upstream, setUpstream] = useState(initialValues?.upstream ?? "");
  const [root, setRoot] = useState(initialValues?.root ?? "");
  const [index, setIndex] = useState(initialValues?.index ?? "");
  const [splitPath, setSplitPath] = useState(initialValues?.splitPath ?? "");
  const [tryFiles, setTryFiles] = useState(initialValues?.tryFiles ?? "");
  const [env, setEnv] = useState<EnvEntry[]>(initialEnv ?? []);
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
  const [portErr, setPortErr] = useState<string | null>(null);
  const [upstreamErr, setUpstreamErr] = useState<string | null>(null);
  const [rootErr, setRootErr] = useState<string | null>(null);

  function validate(): boolean {
    let ok = true;
    const n = parseInt(port, 10);
    if (!port) { setPortErr(t("add_static.validation_port_required")); ok = false; }
    else if (isNaN(n)) { setPortErr(t("add_static.validation_port_number")); ok = false; }
    else if (n < 1 || n > 65535) { setPortErr(t("add_static.validation_port_range")); ok = false; }
    else if (existingPorts.includes(n)) { setPortErr(t("add_static.validation_port_duplicate", { port: n })); ok = false; }
    else setPortErr(null);

    if (!upstream.trim()) { setUpstreamErr(t("php_fastcgi.validation_upstream_required")); ok = false; }
    else setUpstreamErr(null);

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
    <Modal isOpen onClose={onClose} aria-label={t("php_fastcgi.add_aria_label")} variant="medium">
      <ModalHeader title={t("php_fastcgi.add_title")} />
      <ModalBody>
        {isLocked && (
          <Alert
            variant="warning"
            isInline
            title={t("php_fastcgi.add_confirm_body", { port })}
            style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}
          />
        )}

        <ProxyTabs
          state={tabState}
          onChange={updateTabState}
          active={activeTab}
          onSelect={setActiveTab}
          isDisabled={isLocked}
          idPrefix="add-php"
          layout="site"
          showTls={true}
          generalHasError={!!(portErr || upstreamErr || rootErr)}
          general={
            <Form isHorizontal>
              <FormGroup label={t("add_proxy.field_label")} fieldId="php-label">
                <TextInput
                  id="php-label"
                  value={label}
                  onChange={(_e, v) => setLabel(v)}
                  placeholder={t("common.example_value", { value: t("add_proxy.field_label_placeholder") })}
                  isDisabled={isLocked}
                />
              </FormGroup>

              <FormGroup label={t("add_redirect.field_from_port")} fieldId="php-port" isRequired>
                <TextInput
                  id="php-port"
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

              <FormGroup label={t("php_fastcgi.field_upstream")} fieldId="php-upstream" isRequired>
                <TextInput
                  id="php-upstream"
                  value={upstream}
                  onChange={(_e, v) => { setUpstream(v); setUpstreamErr(null); }}
                  placeholder={t("common.example_value", { value: "unix//run/php-fpm.sock" })}
                  isDisabled={isLocked}
                  validated={upstreamErr ? "error" : "default"}
                />
                {upstreamErr ? (
                  <FormHelperText>
                    <HelperText><HelperTextItem variant="error">{upstreamErr}</HelperTextItem></HelperText>
                  </FormHelperText>
                ) : (
                  <FormHelperText>
                    <HelperText><HelperTextItem>{t("php_fastcgi.field_upstream_help")}</HelperTextItem></HelperText>
                  </FormHelperText>
                )}
              </FormGroup>

              <FormGroup label={t("add_static.field_root")} fieldId="php-root" isRequired>
                <TextInput
                  id="php-root"
                  value={root}
                  onChange={(_e, v) => { setRoot(v); setRootErr(null); }}
                  placeholder={t("common.example_value", { value: t("add_static.field_root_placeholder") })}
                  isDisabled={isLocked}
                  validated={rootErr ? "error" : "default"}
                />
                {rootErr && (
                  <FormHelperText>
                    <HelperText><HelperTextItem variant="error">{rootErr}</HelperTextItem></HelperText>
                  </FormHelperText>
                )}
              </FormGroup>

              <FormGroup label={t("php_fastcgi.field_index")} fieldId="php-index">
                <TextInput
                  id="php-index"
                  value={index}
                  onChange={(_e, v) => setIndex(v)}
                  placeholder={t("common.default_value", { value: "index.php" })}
                  isDisabled={isLocked}
                />
              </FormGroup>

              <FormGroup label={t("php_fastcgi.field_split_path")} fieldId="php-split-path">
                <TextInput
                  id="php-split-path"
                  value={splitPath}
                  onChange={(_e, v) => setSplitPath(v)}
                  placeholder={t("common.default_value", { value: ".php" })}
                  isDisabled={isLocked}
                />
                <FormHelperText>
                  <HelperText><HelperTextItem>{t("php_fastcgi.field_split_path_help")}</HelperTextItem></HelperText>
                </FormHelperText>
              </FormGroup>

              <PhpTryFilesField id="php-try-files" value={tryFiles} onChange={setTryFiles} isDisabled={isLocked} />

              <TlsModeField id="php-tls" value={tlsMode} onChange={setTlsModeChoice} publicName={publicName} isDisabled={isLocked} onDemand={tlsOnDemand} onOnDemandChange={setTlsOnDemand} />

              <FormGroup fieldId="php-compress">
                <Checkbox
                  id="php-compress"
                  label={t("add_proxy.field_compress_short")}
                  isChecked={compress}
                  onChange={(_e, v) => setCompress(v)}
                  isDisabled={isLocked}
                />
              </FormGroup>
              <SnippetImportsField value={imports} onChange={setImports} isDisabled={isLocked} />
              <PhpFastcgiEnvSection value={env} onChange={setEnv} isDisabled={isLocked} />
            </Form>
          }
        />

        {confirmAction.error && (
          <Alert variant="danger" isInline title={confirmAction.error} style={{ marginTop: "var(--pf-v6-global--spacer--md)" }} />
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
                    externalPort: parseInt(port, 10),
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
                    phpFastcgi: {
                      upstream: upstream.trim(),
                      root: root.trim(),
                      index: index.trim() || undefined,
                      splitPath: splitPath.trim() ? splitPath.trim().split(/\s+/) : undefined,
                      tryFiles: tryFiles.trim() || undefined,
                      env: envEntriesToRecord(env),
                    },
                    ...tabEntry,
                    imports,
                  });
                } catch (e) {
                  if (e instanceof CaddyApiError) {
                    onClose();
                    toast.error(t("proxies.api_error_add_title"), e.message);
                    return;
                  }
                  throw e;
                }
                toast.success(t("toast.proxy_added", { port }));
                onClose();
              })}
            >
              {t("service.confirm_action")}
            </Button>
            <Button variant="link" onClick={confirmAction.cancel} isDisabled={isSaving}>{t("common.back")}</Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={handleAdd}>{t("php_fastcgi.add_button")}</Button>
            <Button variant="link" onClick={onClose}>{t("common.cancel")}</Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
