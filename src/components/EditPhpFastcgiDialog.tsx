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
import { useConfirmAction } from "@rxtx4816/cockpit-plugin-base-react";
import { useToast } from "@rxtx4816/cockpit-plugin-base-react/components";
import { CaddyApiError } from "../api";
import { SectionActions } from "./SectionActions";
import type { ProxyEntry, ErrorHandlerConfig, RouteMatch } from "../api";
import { RouteMatchersSection } from "./RouteMatchersSection";
import { BasicAuthSection, resolveBasicAuth, type AuthEntry } from "./BasicAuthSection";
import { ResponseHeadersSection } from "./ResponseHeadersSection";
import { RequestHeadersSection } from "./RequestHeadersSection";
import { AccessLogSection, type AccessLogValues, accessLogConfigToValues, accessLogValuesToConfig } from "./AccessLogSection";
import { ServerTimeoutsSection, type ServerTimeoutValues } from "./ServerTimeoutsSection";
import { RequestBodyLimitField } from "./RequestBodyLimitField";
import { ErrorHandlersSection } from "./ErrorHandlersSection";
import { TlsSection, type TlsValues, tlsValuesToAdvanced, tlsValuesToMtls, tlsConfigToValues } from "./TlsSection";
import { PhpFastcgiEnvSection, envEntriesToRecord, envRecordToEntries, type EnvEntry } from "./PhpFastcgiEnvSection";
import { sectionAccordionProps } from "./sectionAccordion";
import { AccordionRow } from "./AccordionRow";

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
  const [env, setEnv] = useState<EnvEntry[]>(envRecordToEntries(proxy.phpFastcgi?.env));
  const [tls, setTls] = useState(proxy.tls);
  const [compress, setCompress] = useState(proxy.compress ?? false);
  const [label, setLabel] = useState(proxy.label ?? "");
  const [basicAuth, setBasicAuth] = useState<AuthEntry[]>(
    (proxy.basicAuth ?? []).map(a => ({ username: a.username, password: "", existingHash: a.passwordHash })),
  );
  const [responseHeaders, setResponseHeaders] = useState(proxy.responseHeaders ?? []);
  const [requestHeaders, setRequestHeaders] = useState(proxy.requestHeaders);
  const [accessLog, setAccessLog] = useState<AccessLogValues>(accessLogConfigToValues(proxy.accessLog));
  const [serverTimeouts, setServerTimeouts] = useState<ServerTimeoutValues>({
    readTimeout: proxy.serverReadTimeout ?? "",
    readHeaderTimeout: proxy.serverReadHeaderTimeout ?? "",
    writeTimeout: proxy.serverWriteTimeout ?? "",
    idleTimeout: proxy.serverIdleTimeout ?? "",
    maxHeaderBytes: proxy.maxHeaderBytes != null ? String(proxy.maxHeaderBytes) : "",
    disableHttp3: proxy.disableHttp3 ?? false,
  });
  const [requestBodyMaxSize, setRequestBodyMaxSize] = useState(proxy.requestBodyMaxSize != null ? String(proxy.requestBodyMaxSize) : "");
  const [errorHandlers, setErrorHandlers] = useState<ErrorHandlerConfig[]>(proxy.errorHandlers ?? []);
  const [tlsValues, setTlsValues] = useState<TlsValues>(tlsConfigToValues(proxy.tlsAdvanced, proxy.mtls));
  const [matchers, setMatchers] = useState<RouteMatch | undefined>(proxy.matchers);
  const [handlePath, setHandlePath] = useState(proxy.handlePath ?? false);
  const [portErr, setPortErr] = useState<string | null>(null);
  const [upstreamErr, setUpstreamErr] = useState<string | null>(null);
  const [rootErr, setRootErr] = useState<string | null>(null);
  const [expandedSection, setExpandedSection] = useState<string | null>(null);

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
    if (validate()) confirmAction.confirm();
  }

  const isLocked = confirmAction.step !== "idle";
  const isSaving = confirmAction.step === "submitting";

  return (
    <Modal isOpen onClose={onClose} aria-label={t("php_fastcgi.edit_aria_label")} variant="medium">
      <ModalHeader title={t("php_fastcgi.edit_title", { port: proxy.externalPort })} />
      <ModalBody>
        {isLocked && (
          <Alert
            variant="warning"
            isInline
            title={t("php_fastcgi.edit_confirm_body", { port })}
            style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}
          />
        )}

        <Form isHorizontal>
          <FormGroup label={t("add_proxy.field_label")} fieldId="php-edit-label">
            <TextInput
              id="php-edit-label"
              value={label}
              onChange={(_e, v) => setLabel(v)}
              placeholder={t("add_proxy.field_label_placeholder")}
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
              placeholder="unix//run/php-fpm.sock"
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
              placeholder={t("add_static.field_root_placeholder")}
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
              placeholder="index.php"
              isDisabled={isLocked}
            />
          </FormGroup>

          <FormGroup label={t("php_fastcgi.field_split_path")} fieldId="php-edit-split-path">
            <TextInput
              id="php-edit-split-path"
              value={splitPath}
              onChange={(_e, v) => setSplitPath(v)}
              placeholder=".php"
              isDisabled={isLocked}
            />
            <FormHelperText>
              <HelperText><HelperTextItem>{t("php_fastcgi.field_split_path_help")}</HelperTextItem></HelperText>
            </FormHelperText>
          </FormGroup>

          <FormGroup fieldId="php-edit-tls">
            <Checkbox
              id="php-edit-tls"
              label={t("add_proxy.field_tls_short")}
              isChecked={tls}
              onChange={(_e, v) => setTls(v)}
              isDisabled={isLocked}
            />
            <SectionActions onDefaults={() => setTls(true)} isDisabled={isLocked} />
          </FormGroup>

          <FormGroup fieldId="php-edit-compress">
            <Checkbox
              id="php-edit-compress"
              label={t("add_proxy.field_compress_short")}
              isChecked={compress}
              onChange={(_e, v) => setCompress(v)}
              isDisabled={isLocked}
            />
          </FormGroup>
          <RequestBodyLimitField value={requestBodyMaxSize} onChange={setRequestBodyMaxSize} isDisabled={isLocked} idPrefix="edit-php" />
        </Form>

        <div
          style={{
            border: "1px solid var(--pf-t--global--border--color--default)",
            borderRadius: "var(--pf-t--global--border--radius--small)",
            padding: "0 0.75rem",
            marginTop: "var(--pf-v6-global--spacer--md)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <AccordionRow>
            <TlsSection value={tlsValues} onChange={setTlsValues} isDisabled={isLocked} {...sectionAccordionProps("tls", expandedSection, setExpandedSection)} />
          </AccordionRow>
          <AccordionRow>
            <AccessLogSection value={accessLog} onChange={setAccessLog} isDisabled={isLocked} {...sectionAccordionProps("accessLog", expandedSection, setExpandedSection)} />
          </AccordionRow>
          <AccordionRow>
            <ErrorHandlersSection value={errorHandlers} onChange={setErrorHandlers} isDisabled={isLocked} {...sectionAccordionProps("errorHandlers", expandedSection, setExpandedSection)} />
          </AccordionRow>
          <AccordionRow>
            <ServerTimeoutsSection value={serverTimeouts} onChange={setServerTimeouts} isDisabled={isLocked} {...sectionAccordionProps("serverTimeouts", expandedSection, setExpandedSection)} />
          </AccordionRow>
          <AccordionRow>
            <PhpFastcgiEnvSection value={env} onChange={setEnv} isDisabled={isLocked} {...sectionAccordionProps("env", expandedSection, setExpandedSection)} />
          </AccordionRow>
          <AccordionRow>
            <BasicAuthSection
              value={basicAuth}
              onChange={setBasicAuth}
              isDisabled={isLocked}
              {...sectionAccordionProps("basicAuth", expandedSection, setExpandedSection)}
            />
          </AccordionRow>
          <AccordionRow>
            <RequestHeadersSection value={requestHeaders} onChange={setRequestHeaders} isDisabled={isLocked} {...sectionAccordionProps("requestHeaders", expandedSection, setExpandedSection)} />
          </AccordionRow>
          <AccordionRow>
            <ResponseHeadersSection
              value={responseHeaders}
              onChange={v => setResponseHeaders(v ?? [])}
              isDisabled={isLocked}
              {...sectionAccordionProps("responseHeaders", expandedSection, setExpandedSection)}
            />
          </AccordionRow>
          <AccordionRow last>
            <RouteMatchersSection value={matchers} onChange={v => { setMatchers(v); if (!v?.path?.length) setHandlePath(false); }} isDisabled={isLocked} {...sectionAccordionProps("routeMatchers", expandedSection, setExpandedSection)} />
          </AccordionRow>
        </div>
        {matchers?.path?.length && !matchers.host?.length && !matchers.method?.length && !matchers.header && !matchers.query && !matchers.remote_ip && (
          <Checkbox
            id="edit-php-handle-path"
            label={t("handle_path.label")}
            isChecked={handlePath}
            onChange={(_e, v) => setHandlePath(v)}
            isDisabled={isLocked}
            style={{ marginLeft: "1rem", marginBottom: "0.5rem" }}
          />
        )}

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
                const resolvedAuth = await resolveBasicAuth(basicAuth);
                try {
                  await onSave({
                    ...proxy,
                    externalPort: parseInt(port, 10),
                    tls,
                    compress: compress || undefined,
                    label: label.trim() || undefined,
                    phpFastcgi: {
                      upstream: upstream.trim(),
                      root: root.trim(),
                      index: index.trim() || undefined,
                      splitPath: splitPath.trim() ? splitPath.trim().split(/\s+/) : undefined,
                      env: envEntriesToRecord(env),
                    },
                    basicAuth: resolvedAuth.length ? resolvedAuth : undefined,
                    requestHeaders: requestHeaders ?? undefined,
                    responseHeaders: responseHeaders.length ? responseHeaders : undefined,
                    accessLog: accessLogValuesToConfig(accessLog),
                    errorHandlers: errorHandlers.length ? errorHandlers : undefined,
                    serverReadTimeout: serverTimeouts.readTimeout.trim() || undefined,
                    serverReadHeaderTimeout: serverTimeouts.readHeaderTimeout.trim() || undefined,
                    serverWriteTimeout: serverTimeouts.writeTimeout.trim() || undefined,
                    serverIdleTimeout: serverTimeouts.idleTimeout.trim() || undefined,
                    maxHeaderBytes: serverTimeouts.maxHeaderBytes.trim() ? parseInt(serverTimeouts.maxHeaderBytes, 10) : undefined,
                    disableHttp3: serverTimeouts.disableHttp3 || undefined,
                    requestBodyMaxSize: requestBodyMaxSize.trim() ? parseInt(requestBodyMaxSize, 10) : undefined,
                    tlsAdvanced: tlsValuesToAdvanced(tlsValues),
                    mtls: tlsValuesToMtls(tlsValues),
                    matchers: matchers ?? undefined,
                    handlePath: handlePath || undefined,
                  });
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
