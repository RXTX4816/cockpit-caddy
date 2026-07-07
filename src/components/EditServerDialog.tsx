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
import type { ServerDef, ErrorHandlerConfig } from "../api";
import { namedServerIsHostless } from "../api";
import { TlsSection, type TlsValues, tlsValuesToAdvanced, tlsValuesToMtls, tlsConfigToValues, tlsValuesHaveErrors } from "./TlsSection";
import { ServerTimeoutsSection, type ServerTimeoutValues } from "./ServerTimeoutsSection";
import { AccessLogSection, type AccessLogValues, accessLogValuesToConfig, accessLogConfigToValues } from "./AccessLogSection";
import { ErrorHandlersSection } from "./ErrorHandlersSection";
import { sectionAccordionProps } from "./sectionAccordion";
import { AccordionRow } from "./AccordionRow";

interface Props {
  def: ServerDef;
  onSave: (def: ServerDef) => Promise<void>;
  onClose: () => void;
}

export function EditServerDialog({ def, onSave, onClose }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirmAction = useConfirmAction();

  const [name, setName] = useState(def.name);
  const [listenAddresses, setListenAddresses] = useState<string[]>(def.listenAddresses);
  const [newPort, setNewPort] = useState("");
  const [tls, setTls] = useState(def.tls);
  const [tlsValues, setTlsValues] = useState<TlsValues>(tlsConfigToValues(def.tlsAdvanced, def.mtls));
  const [serverTimeouts, setServerTimeouts] = useState<ServerTimeoutValues>({
    readTimeout: def.serverReadTimeout ?? "",
    readHeaderTimeout: def.serverReadHeaderTimeout ?? "",
    writeTimeout: def.serverWriteTimeout ?? "",
    idleTimeout: def.serverIdleTimeout ?? "",
    maxHeaderBytes: def.maxHeaderBytes != null ? String(def.maxHeaderBytes) : "",
    disableHttp3: def.disableHttp3 ?? false,
  });
  const [accessLog, setAccessLog] = useState<AccessLogValues>(accessLogConfigToValues(def.accessLog));
  const [errorHandlers, setErrorHandlers] = useState<ErrorHandlerConfig[]>(def.errorHandlers ?? []);

  const [nameErr, setNameErr] = useState<string | null>(null);
  const [addrErr, setAddrErr] = useState<string | null>(null);
  const [expandedSection, setExpandedSection] = useState<string | null>(null);

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
    if (listenAddresses.length === 0) { setAddrErr(t("servers.validation_addr_required")); ok = false; }
    return ok;
  }

  function handleSaveClick() {
    if (validate()) confirmAction.confirm();
  }

  const isLocked = confirmAction.step !== "idle";
  const isSaving = confirmAction.step === "submitting";

  return (
    <Modal isOpen onClose={onClose} aria-label={t("servers.edit_server")} variant="medium">
      <ModalHeader title={t("servers.edit_server")} />
      <ModalBody>
        {isLocked && (
          <Alert
            variant="warning"
            isInline
            title={t("servers.confirm_edit")}
            style={{ marginBottom: "var(--pf-v6-global--spacer--md)" }}
          />
        )}

        <Form isHorizontal>
          <FormGroup label={t("servers.field_name")} fieldId="edit-server-name" isRequired>
            <TextInput
              id="edit-server-name"
              value={name}
              onChange={(_e, v) => { setName(v); if (nameErr) setNameErr(null); }}
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

          <FormGroup label={t("servers.field_key")} fieldId="edit-server-key">
            <code style={{ fontFamily: "monospace", fontSize: "0.9em" }}>{def.key}</code>
            <FormHelperText>
              <HelperText><HelperTextItem>{t("servers.field_key_help")}</HelperTextItem></HelperText>
            </FormHelperText>
          </FormGroup>

          <FormGroup label={t("servers.field_listen")} fieldId="edit-server-listen" isRequired>
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
                  id="edit-server-new-addr"
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

          <FormGroup label={t("add_proxy.field_tls")} fieldId="edit-server-tls">
            <Checkbox
              id="edit-server-tls"
              label={t("add_proxy.field_tls_short")}
              isChecked={tls}
              onChange={(_e, v) => setTls(v)}
              isDisabled={isLocked}
            />
          </FormGroup>
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
            <TlsSection value={tlsValues} onChange={setTlsValues} isDisabled={isLocked} hostless={namedServerIsHostless(listenAddresses)} {...sectionAccordionProps("tls", expandedSection, setExpandedSection)} />
          </AccordionRow>
          <AccordionRow>
            <AccessLogSection value={accessLog} onChange={setAccessLog} isDisabled={isLocked} {...sectionAccordionProps("accessLog", expandedSection, setExpandedSection)} />
          </AccordionRow>
          <AccordionRow>
            <ErrorHandlersSection value={errorHandlers} onChange={setErrorHandlers} isDisabled={isLocked} {...sectionAccordionProps("errorHandlers", expandedSection, setExpandedSection)} />
          </AccordionRow>
          <AccordionRow last>
            <ServerTimeoutsSection value={serverTimeouts} onChange={setServerTimeouts} isDisabled={isLocked} {...sectionAccordionProps("serverTimeouts", expandedSection, setExpandedSection)} />
          </AccordionRow>
        </div>

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
                await onSave({
                  key: def.key,
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
                  routeLabels: def.routeLabels,
                });
                toast.success(t("toast.server_saved", { name: name.trim() }));
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
            <Button variant="primary" onClick={handleSaveClick} isDisabled={tlsValuesHaveErrors(tlsValues)}>
              {t("common.save")}
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
