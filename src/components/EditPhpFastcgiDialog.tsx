import { useState } from "react";
import {
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
import { CaddyApiError, saveWithDnsSecrets } from "../api";
import { useSiteDns } from "./SiteDnsChallenge";
import { TlsModeField, hasPublicName, tlsModeToEntry, type TlsMode, tlsModeOf } from "./TlsModeField";
import type { ProxyEntry } from "../api";
import { SnippetImportsField } from "./SnippetImportsField";
import { ProxyTabs } from "./ProxyTabs";
import { firstTabWithError, type ProxyTabKey } from "./proxyDialogParts";
import { proxyTabStateFlags, proxyTabStateFromEntry, proxyTabStateToEntry, useProxyTabState } from "./proxyTabState";
import { PhpFastcgiEnvSection, envEntriesToRecord, envRecordToEntries, type EnvEntry } from "./PhpFastcgiEnvSection";
import { Notice } from "./Notice";

interface Props {
  proxy: ProxyEntry;
  existingPorts: number[];
  onSave: (entry: ProxyEntry) => Promise<void>;
  onClose: () => void;
}

export function EditPhpFastcgiDialog({ proxy, existingPorts, onSave, onClose }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirmAction = useConfirmAction();

  const [port, setPort] = useState(String(proxy.externalPort));
  const [upstream, setUpstream] = useState(proxy.phpFastcgi?.upstream ?? "");
  const [root, setRoot] = useState(proxy.phpFastcgi?.root ?? "");
  const [index, setIndex] = useState(proxy.phpFastcgi?.index ?? "");
  const [splitPath, setSplitPath] = useState(proxy.phpFastcgi?.splitPath?.join(" ") ?? "");
  const [tryFiles, setTryFiles] = useState(proxy.phpFastcgi?.tryFiles ?? "");
  const [env, setEnv] = useState<EnvEntry[]>(envRecordToEntries(proxy.phpFastcgi?.env));
  // #246: where the certificate comes from; ACME needs a public name in the site address.
  const [tlsModeChoice, setTlsModeChoice] = useState<TlsMode>(tlsModeOf(proxy));
  const publicName = hasPublicName(proxy.externalHost);
  const tlsMode: TlsMode = tlsModeChoice === "acme" && !publicName ? "internal" : tlsModeChoice;
  const [tlsOnDemand, setTlsOnDemand] = useState(!!proxy.tlsOnDemand);
  const siteDns = useSiteDns(proxy.dnsChallenge, tlsMode === "acme");
  const [compress, setCompress] = useState(proxy.compress ?? false);
  const [label, setLabel] = useState(proxy.label ?? "");
  const [tabState, updateTabState] = useProxyTabState(proxyTabStateFromEntry(proxy));
  const [activeTab, setActiveTab] = useState<ProxyTabKey>("general");
  const [imports, setImports] = useState<string[] | undefined>(proxy.imports);
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

  function handleSave() {
    const errorTab = firstTabWithError(proxyTabStateFlags(tabState, !validate(), "site").hasError)
      ?? (siteDns.error(proxy.externalHost, tlsMode === "acme") ? "general" : undefined);
    if (errorTab) {
      setActiveTab(errorTab);
      return;
    }
    confirmAction.confirm();
  }

  const isLocked = confirmAction.step !== "idle";
  const isSaving = confirmAction.step === "submitting";

  return (
    <Modal isOpen onClose={onClose} aria-label={t("php_fastcgi.edit_aria_label")} variant="medium">
      <ModalHeader title={t("php_fastcgi.edit_title", { port: proxy.externalPort })} />
      <ModalBody>
        {isLocked && (
          <Notice
            variant="warning"
           
            title={t("php_fastcgi.edit_confirm_body", { port })}
          />
        )}

        <ProxyTabs
          state={tabState}
          onChange={updateTabState}
          active={activeTab}
          onSelect={setActiveTab}
          isDisabled={isLocked}
          idPrefix="edit-php"
          layout="site"
          showTls={true}
          generalHasError={!!(portErr || upstreamErr || rootErr)}
          general={
            <Form isHorizontal>
              <FormGroup label={t("add_proxy.field_label")} fieldId="php-edit-label">
                <TextInput
                  id="php-edit-label"
                  value={label}
                  onChange={(_e, v) => setLabel(v)}
                  placeholder={t("common.example_value", { value: t("add_proxy.field_label_placeholder") })}
                  isDisabled={isLocked}
                />
              </FormGroup>

              <FormGroup label={t("add_redirect.field_from_port")} fieldId="php-edit-port" isRequired>
                <TextInput
                  id="php-edit-port"
                  type="number"
                  value={port}
                  onChange={(_e, v) => { setPort(v); setPortErr(null); }}
                  isDisabled={isLocked}
                  validated={portErr ? "error" : "default"}
                />
                {portErr && (
                  <FormHelperText>
                    <HelperText><HelperTextItem variant="error">{portErr}</HelperTextItem></HelperText>
                  </FormHelperText>
                )}
              </FormGroup>

              <FormGroup label={t("php_fastcgi.field_upstream")} fieldId="php-edit-upstream" isRequired>
                <TextInput
                  id="php-edit-upstream"
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

              <FormGroup label={t("add_static.field_root")} fieldId="php-edit-root" isRequired>
                <TextInput
                  id="php-edit-root"
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

              <FormGroup label={t("php_fastcgi.field_index")} fieldId="php-edit-index">
                <TextInput
                  id="php-edit-index"
                  value={index}
                  onChange={(_e, v) => setIndex(v)}
                  placeholder={t("common.default_value", { value: "index.php" })}
                  isDisabled={isLocked}
                />
              </FormGroup>

              <FormGroup label={t("php_fastcgi.field_split_path")} fieldId="php-edit-split-path">
                <TextInput
                  id="php-edit-split-path"
                  value={splitPath}
                  onChange={(_e, v) => setSplitPath(v)}
                  placeholder={t("common.default_value", { value: ".php" })}
                  isDisabled={isLocked}
                />
                <FormHelperText>
                  <HelperText><HelperTextItem>{t("php_fastcgi.field_split_path_help")}</HelperTextItem></HelperText>
                </FormHelperText>
              </FormGroup>

              <PhpTryFilesField id="php-edit-try-files" value={tryFiles} onChange={setTryFiles} isDisabled={isLocked} />

              <TlsModeField id="php-edit-tls" value={tlsMode} onChange={setTlsModeChoice} publicName={publicName} isDisabled={isLocked} onDemand={tlsOnDemand} onOnDemandChange={setTlsOnDemand} dns={siteDns} host={proxy.externalHost} />

              <FormGroup fieldId="php-edit-compress">
                <Checkbox
                  id="php-edit-compress"
                  label={t("add_proxy.field_compress_short")}
                  isChecked={compress}
                  onChange={(_e, v) => setCompress(v)}
                  isDisabled={isLocked}
                />
              </FormGroup>
              <SnippetImportsField value={imports} onChange={setImports} snippetSettings={proxy.snippetSettings} isDisabled={isLocked} />
              <PhpFastcgiEnvSection value={env} onChange={setEnv} isDisabled={isLocked} />
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
                const dns = siteDns.plan(proxy.externalHost, tlsMode === "acme");
                try {
                  await saveWithDnsSecrets(dns.secrets, () => onSave({
                    ...proxy,
                    externalPort: parseInt(port, 10),
                    ...tlsModeToEntry(tlsMode, proxy.externalHost),
                    tlsOnDemand: tlsMode !== "off" && tlsOnDemand ? true : undefined,
                    dnsChallenge: dns.config,
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
                  }));
                } catch (e) {
                  if (e instanceof CaddyApiError) {
                    onClose();
                    toast.error(t("proxies.api_error_edit_title"), e.message);
                    return;
                  }
                  throw e;
                }
                toast.success(t("toast.proxy_saved", { port }));
                onClose();
              })}
            >
              {t("service.confirm_action")}
            </Button>
            <Button variant="link" onClick={confirmAction.cancel} isDisabled={isSaving}>{t("common.back")}</Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={handleSave}>{t("php_fastcgi.edit_save_button")}</Button>
            <Button variant="link" onClick={onClose}>{t("common.cancel")}</Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
