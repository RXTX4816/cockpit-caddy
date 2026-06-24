import {
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardTitle,
  Label,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { ProxyEntry } from "../api";

interface Props {
  proxy: ProxyEntry;
  onEdit: (p: ProxyEntry) => void;
  onDelete: (p: ProxyEntry) => void;
  onDuplicate: (p: ProxyEntry) => void;
}

export function ProxyCard({ proxy, onEdit, onDelete, onDuplicate }: Props) {
  const { t } = useTranslation();
  const proto = proxy.tls ? "https" : "http";
  const url = `${proto}://${window.location.hostname}:${proxy.externalPort}`;

  return (
    <Card isCompact isFullHeight>
      <CardHeader>
        <CardTitle>
          {proxy.label
            ? <strong>{proxy.label}</strong>
            : <a href={url} target="_blank" rel="noopener noreferrer" style={{ fontFamily: "monospace", fontWeight: "bold" }}>:{proxy.externalPort}</a>
          }
        </CardTitle>
      </CardHeader>
      <CardBody>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", fontSize: "0.85rem" }}>
          {proxy.label && (
            <a href={url} target="_blank" rel="noopener noreferrer" style={{ fontFamily: "monospace", fontWeight: 600 }}>
              :{proxy.externalPort}
            </a>
          )}
          <code style={{ color: "var(--pf-t--global--text--color--subtle)" }}>
            → {proxy.targetScheme}://{proxy.targetHost}:{proxy.targetPort}
          </code>
          <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
            {proxy.tls && <Label isCompact color="blue">{t("proxies.tls_self_signed")}</Label>}
            {proxy.tlsSkipVerify && <Label isCompact color="orange">{t("proxies.tls_skip_verify")}</Label>}
            {!proxy.tls && <Label isCompact color="grey">{t("proxies.tls_none")}</Label>}
          </div>
        </div>
      </CardBody>
      <CardFooter>
        <div style={{ display: "flex", gap: "0.25rem" }}>
          <Button variant="plain" size="sm" onClick={() => onEdit(proxy)}>{t("common.edit")}</Button>
          <Button variant="plain" size="sm" onClick={() => onDuplicate(proxy)}>{t("common.duplicate")}</Button>
          <Button variant="plain" size="sm" isDanger onClick={() => onDelete(proxy)}>{t("common.delete")}</Button>
        </div>
      </CardFooter>
    </Card>
  );
}
