import { useEffect, useState } from "react";
import {
  Alert,
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
  Tooltip,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import { useAdminAddress } from "../hooks/useAdminAddress";
import { useLogContainer } from "../hooks/useLogContainer";
import { ADMIN_TCP_DEFAULT, ADMIN_SOCKET_DEFAULT } from "../api/caddy";
import { testTcpConnection, testUnixSocket, testDockerContainer } from "../api";

interface Props {
  onClose: () => void;
}

type TestResult = "ok" | "fail" | null;

export function AdminAddressDialog({ onClose }: Props) {
  const { t } = useTranslation();
  const { tcp, socket, save } = useAdminAddress();
  const { container, save: saveContainer } = useLogContainer();
  const [tcpValue, setTcpValue] = useState(tcp);
  const [socketValue, setSocketValue] = useState(socket);
  const [containerValue, setContainerValue] = useState(container);
  const [testingTcp, setTestingTcp] = useState(false);
  const [testingSocket, setTestingSocket] = useState(false);
  const [testingContainer, setTestingContainer] = useState(false);
  const [tcpResult, setTcpResult] = useState<TestResult>(null);
  const [socketResult, setSocketResult] = useState<TestResult>(null);
  const [containerResult, setContainerResult] = useState<TestResult>(null);

  const canSave = tcpResult === "ok" || socketResult === "ok";

  async function handleTestTcp() {
    setTestingTcp(true);
    setTcpResult(null);
    const ok = await testTcpConnection(tcpValue);
    setTcpResult(ok ? "ok" : "fail");
    setTestingTcp(false);
  }

  async function handleTestSocket() {
    setTestingSocket(true);
    setSocketResult(null);
    const ok = await testUnixSocket(socketValue);
    setSocketResult(ok ? "ok" : "fail");
    setTestingSocket(false);
  }

  async function handleTestContainer() {
    setTestingContainer(true);
    setContainerResult(null);
    const ok = await testDockerContainer(containerValue);
    setContainerResult(ok ? "ok" : "fail");
    setTestingContainer(false);
  }

  useEffect(() => {
    // Auto-test the stored values once on dialog open so the user isn't
    // left guessing why Save is disabled.
    void handleTestTcp();
    void handleTestSocket();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSave() {
    save(tcpValue, socketValue);
    saveContainer(containerValue);
    onClose();
  }

  function handleReset() {
    setTcpValue(ADMIN_TCP_DEFAULT);
    setSocketValue(ADMIN_SOCKET_DEFAULT);
    setContainerValue("");
    setTcpResult(null);
    setSocketResult(null);
    setContainerResult(null);
  }

  function handleFieldChange(setter: (v: string) => void, clearResult: () => void) {
    return (_e: unknown, v: string) => {
      setter(v);
      clearResult();
    };
  }

  return (
    <Modal isOpen onClose={onClose} variant="small" aria-label={t("admin_address.title")}>
      <ModalHeader title={t("admin_address.title")} />
      <ModalBody>
        <Alert variant="info" isInline title={t("admin_address.storage_note")} style={{ marginBottom: "1rem" }} />
        <Form isHorizontal>
          <FormGroup label={t("admin_address.tcp_label")} fieldId="aa-tcp">
            <TextInput
              id="aa-tcp"
              value={tcpValue}
              onChange={handleFieldChange(setTcpValue, () => setTcpResult(null))}
              placeholder={ADMIN_TCP_DEFAULT}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>{t("admin_address.tcp_help")}</HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>
          <FormGroup label="" fieldId="aa-tcp-test">
            <Button
              id="aa-tcp-test"
              variant="secondary"
              size="sm"
              onClick={() => void handleTestTcp()}
              isLoading={testingTcp}
              isDisabled={testingTcp}
            >
              {t("admin_address.test_tcp_button")}
            </Button>
            {tcpResult === "ok" && (
              <Alert variant="success" isInline title={t("admin_address.test_ok")} style={{ marginTop: "0.5rem" }} />
            )}
            {tcpResult === "fail" && (
              <Alert variant="danger" isInline title={t("admin_address.test_tcp_fail")} style={{ marginTop: "0.5rem" }} />
            )}
          </FormGroup>
          <FormGroup label={t("admin_address.socket_label")} fieldId="aa-socket">
            <TextInput
              id="aa-socket"
              value={socketValue}
              onChange={handleFieldChange(setSocketValue, () => setSocketResult(null))}
              placeholder={ADMIN_SOCKET_DEFAULT}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>{t("admin_address.socket_help")}</HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>
          <FormGroup label="" fieldId="aa-socket-test">
            <Button
              id="aa-socket-test"
              variant="secondary"
              size="sm"
              onClick={() => void handleTestSocket()}
              isLoading={testingSocket}
              isDisabled={testingSocket}
            >
              {t("admin_address.test_socket_button")}
            </Button>
            {socketResult === "ok" && (
              <Alert variant="success" isInline title={t("admin_address.test_ok")} style={{ marginTop: "0.5rem" }} />
            )}
            {socketResult === "fail" && (
              <Alert variant="danger" isInline title={t("admin_address.test_socket_fail")} style={{ marginTop: "0.5rem" }} />
            )}
          </FormGroup>
          <FormGroup label={t("admin_address.container_label")} fieldId="aa-container">
            <TextInput
              id="aa-container"
              value={containerValue}
              onChange={handleFieldChange(setContainerValue, () => setContainerResult(null))}
              placeholder="caddy"
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>{t("admin_address.container_help")}</HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>
          <FormGroup label="" fieldId="aa-container-test">
            <Button
              id="aa-container-test"
              variant="secondary"
              size="sm"
              onClick={() => void handleTestContainer()}
              isLoading={testingContainer}
              isDisabled={testingContainer || !containerValue}
            >
              {t("admin_address.test_container_button")}
            </Button>
            {containerResult === "ok" && (
              <Alert variant="success" isInline title={t("admin_address.test_ok")} style={{ marginTop: "0.5rem" }} />
            )}
            {containerResult === "fail" && (
              <Alert variant="danger" isInline title={t("admin_address.test_container_fail")} style={{ marginTop: "0.5rem" }} />
            )}
          </FormGroup>
        </Form>
      </ModalBody>
      <ModalFooter>
        <Tooltip
          content={t("admin_address.save_tooltip")}
          trigger={canSave ? "manual" : "mouseenter focus"}
          isVisible={false}
        >
          <Button variant="primary" onClick={handleSave} isDisabled={!canSave} aria-disabled={!canSave}>
            {t("common.save")}
          </Button>
        </Tooltip>
        <Button variant="link" onClick={handleReset}>{t("admin_address.reset_button")}</Button>
        <Button variant="link" onClick={onClose}>{t("common.cancel")}</Button>
      </ModalFooter>
    </Modal>
  );
}
