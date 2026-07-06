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
  InputGroup,
  InputGroupText,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { useConfirmAction } from "@rxtx4816/cockpit-plugin-base-react";
import { useToast } from "@rxtx4816/cockpit-plugin-base-react/components";
import { parseHostPort } from "@rxtx4816/cockpit-plugin-base-react/lib/uri";
import type { ServerDef, ErrorHandlerConfig } from "../api";
import { namedServerIsHostless } from "../api";
import { TlsSection, type TlsValues, tlsValuesToAdvanced, tlsValuesToMtls, tlsConfigToValues, tlsValuesHaveErrors } from "./TlsSection";
import { ServerTimeoutsSection, type ServerTimeoutValues } from "./ServerTimeoutsSection";
import { AccessLogSection, type AccessLogValues, accessLogValuesToConfig, accessLogConfigToValues } from "./AccessLogSection";
import { ErrorHandlersSection } from "./ErrorHandlersSection";

interface Props {
  existingKeys: string[];
  onAdd: (def: ServerDef) => Promise<void>;
  onClose: () => void;
}

function toSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function parseListenPort(addr: string): number {
  return parseHostPort(addr)?.port ?? 443;
}

export { parseListenPort };

export function AddServerDialog({ existingKeys, onAdd, onClose }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirmAction = useConfirmAction();

  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [listenAddresses, setListenAddresses] = useState<string[]>([]);
  const [newPort, setNewPort] = useState("");
  const [tls, setTls] = useState(true);
  const [tlsValues, setTlsValues] = useState<TlsValues>(tlsConfigToValues(undefined, undefined));
  const [serverTimeouts, setServerTimeouts] = useState<ServerTimeoutValues>({
    readTimeout: "", readHeaderTimeout: "", writeTimeout: "", idleTimeout: "", maxHeaderBytes: "", disableHttp3: false,
  });
  const [accessLog, setAccessLog] = useState<AccessLogValues>(accessLogConfigToValues(undefined));
  const [errorHandlers, setErrorHandlers] = useState<ErrorHandlerConfig[]>([]);

  const [nameErr, setNameErr] = useState<string | null>(null);
  const [keyErr, setKeyErr] = useState<string | null>(null);
  const [addrErr, setAddrErr] = useState<string | null>(null);

  function handleNameChange(v: string) {
    setName(v);
    if (nameErr) setNameErr(null);
    if (!keyTouched) setKey(toSlug(v));
  }

  function handleKeyChange(v: string) {
    setKey(v);
    setKeyTouched(true);
    if (keyErr) setKeyErr(null);
  }

  function addAddress() {
    const n = parseInt(newPort.trim(), 10);
    if (!newPort.trim() || isNaN(n) || n < 1 || n > 65535) return;
    const addr = `:${n}`;
    if (listenAddresses.includes(addr)) return;
    setListenAddresses(prev => [...prev, addr]);
    setNewPort("");
    setAddrErr(null);
  }

  function removeAddress(i: number) {
    setListenAddresses(prev => prev.filter((_, idx) => idx !== i));
  }

  function validate(): boolean {
    let ok = true;
    if (!name.trim()) { setNameErr(t("servers.validation_name_required")); ok = false; }
    if (!key.trim()) { setKeyErr(t("servers.validation_key_required")); ok = false; }
    else if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) { setKeyErr(t("servers.validation_key_format")); ok = false; }
    else if (existingKeys.includes(key)) { setKeyErr(t("servers.validation_key_duplicate")); ok = false; }
    if (listenAddresses.length === 0) { setAddrErr(t("servers.validation_addr_required")); ok = false; }
    return ok;
  }

  function handleAddClick() {
    if (validate()) confirmAction.confirm();
  }

  const isLocked = confirmAction.step !== "idle";
  const isSaving = confirmAction.step === "submitting";

  return (
    <Modal isOpen onClose={onClose} aria-label={t("servers.add_server")} variant="medium">
      <ModalHeader title={t("servers.add_server")} />
      <ModalBody>
        {isLocked && (
          <Alert
            variant="warning"
            isInline
            title={t("servers.confirm_add")}
            style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}
          />
        )}

        <Form isHorizontal>
          <FormGroup label={t("servers.field_name")} fieldId="server-name" isRequired>
            <TextInput
              id="server-name"
              value={name}
              onChange={(_e, v) => handleNameChange(v)}
              placeholder={t("servers.name_placeholder")}
              isDisabled={isLocked}
              validated={nameErr ? "error" : "default"}
            />
            {nameErr && (
              <FormHelperText>
                <HelperText><HelperTextItem variant="error">{nameErr}</HelperTextItem></HelperText>
              </FormHelperText>
            )}
          </FormGroup>

          <FormGroup label={t("servers.field_key")} fieldId="server-key" isRequired>
            <TextInput
              id="server-key"
              value={key}
              onChange={(_e, v) => handleKeyChange(v)}
              placeholder={t("servers.key_placeholder")}
              isDisabled={isLocked}
              validated={keyErr ? "error" : "default"}
            />
            {keyErr ? (
              <FormHelperText>
                <HelperText><HelperTextItem variant="error">{keyErr}</HelperTextItem></HelperText>
              </FormHelperText>
            ) : (
              <FormHelperText>
                <HelperText><HelperTextItem>{t("servers.field_key_help")}</HelperTextItem></HelperText>
              </FormHelperText>
            )}
          </FormGroup>

          <FormGroup label={t("servers.field_listen")} fieldId="server-listen" isRequired>
            {listenAddresses.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", marginBottom: "0.4rem" }}>
                {listenAddresses.map((addr, i) => (
                  <div key={i} style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    <code style={{
                      flex: 1,
                      padding: "0.2rem 0.5rem",
                      background: "var(--pf-t--global--background--color--secondary--default)",
                      borderRadius: "3px",
                      fontFamily: "monospace",
                    }}>{addr}</code>
                    <Button
                      variant="plain"
                      size="sm"
                      isDanger
                      onClick={() => removeAddress(i)}
                      isDisabled={isLocked}
                      aria-label={`Remove ${addr}`}
                    >×</Button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: "0.4rem" }}>
              <InputGroup style={{ flex: 1 }}>
                <InputGroupText>:</InputGroupText>
                <TextInput
                  id="server-new-addr"
                  aria-label={t("servers.add_address")}
                  type="number"
                  placeholder="443"
                  value={newPort}
                  onChange={(_e, v) => setNewPort(v)}
                  isDisabled={isLocked}
                  onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addAddress(); } }}
                />
              </InputGroup>
              <Button
                variant="secondary"
                size="sm"
                onClick={addAddress}
                isDisabled={isLocked || !newPort.trim()}
              >
                {t("servers.add_address")}
              </Button>
            </div>
            {addrErr ? (
              <FormHelperText>
                <HelperText><HelperTextItem variant="error">{addrErr}</HelperTextItem></HelperText>
              </FormHelperText>
            ) : (
              <FormHelperText>
                <HelperText><HelperTextItem>{t("servers.field_listen_help")}</HelperTextItem></HelperText>
              </FormHelperText>
            )}
          </FormGroup>

          <FormGroup label={t("add_proxy.field_tls")} fieldId="server-tls">
            <Checkbox
              id="server-tls"
              label={t("add_proxy.field_tls_short")}
              isChecked={tls}
              onChange={(_e, v) => setTls(v)}
              isDisabled={isLocked}
            />
          </FormGroup>
        </Form>

        <TlsSection value={tlsValues} onChange={setTlsValues} isDisabled={isLocked} hostless={namedServerIsHostless(listenAddresses)} />
        <AccessLogSection value={accessLog} onChange={setAccessLog} isDisabled={isLocked} />
        <ErrorHandlersSection value={errorHandlers} onChange={setErrorHandlers} isDisabled={isLocked} />
        <ServerTimeoutsSection value={serverTimeouts} onChange={setServerTimeouts} isDisabled={isLocked} />

        {confirmAction.error && (
          <Alert
            variant="danger"
            isInline
            title={confirmAction.error}
            style={{ marginTop: "var(--pf-v6-global--spacer--md)" }}
          />
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
                await onAdd({
                  key: key.trim(),
                  name: name.trim(),
                  listenAddresses,
                  tls,
                  tlsAdvanced: tlsValuesToAdvanced(tlsValues),
                  mtls: tlsValuesToMtls(tlsValues),
                  serverReadTimeout: serverTimeouts.readTimeout.trim() || undefined,
                  serverReadHeaderTimeout: serverTimeouts.readHeaderTimeout.trim() || undefined,
                  serverWriteTimeout: serverTimeouts.writeTimeout.trim() || undefined,
                  serverIdleTimeout: serverTimeouts.idleTimeout.trim() || undefined,
                  maxHeaderBytes: serverTimeouts.maxHeaderBytes.trim()
                    ? parseInt(serverTimeouts.maxHeaderBytes, 10)
                    : undefined,
                  disableHttp3: serverTimeouts.disableHttp3 || undefined,
                  accessLog: accessLogValuesToConfig(accessLog),
                  errorHandlers: errorHandlers.length ? errorHandlers : undefined,
                });
                toast.success(t("toast.server_added", { name: name.trim() }));
                onClose();
              })}
            >
              {t("service.confirm_action")}
            </Button>
            <Button variant="link" onClick={confirmAction.cancel} isDisabled={isSaving}>
              {t("common.back")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={handleAddClick} isDisabled={tlsValuesHaveErrors(tlsValues)}>
              {t("servers.add_server")}
            </Button>
            <Button variant="link" onClick={onClose}>
              {t("common.cancel")}
            </Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
