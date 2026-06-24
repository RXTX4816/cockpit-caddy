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
  upstreamFailing?: boolean;
}

function FailDot({ t }: { t: (k: string) => string }) {
  return (
    <span
      title={t("proxies.upstream_failing")}
      style={{
        display: "inline-block",
        width: "8px",
        height: "8px",
        borderRadius: "50%",
        backgroundColor: "var(--pf-t--global--color--status--danger--default)",
        marginLeft: "5px",
        verticalAlign: "middle",
        flexShrink: 0,
      }}
    />
  );
}

const chipRow = { display: "flex", gap: "0.2rem", flexWrap: "wrap" } as const;

export function ProxyCard({ proxy, onEdit, onDelete, onDuplicate, upstreamFailing }: Props) {
  const { t } = useTranslation();
  const proto = proxy.tls ? "https" : "http";
  const url = `${proto}://${window.location.hostname}:${proxy.externalPort}`;

  const portLink = (
    <span style={{ display: "inline-flex", alignItems: "center" }}>
      <a href={url} target="_blank" rel="noopener noreferrer" style={{ fontFamily: "monospace", fontWeight: "bold" }}>
        :{proxy.externalPort}
      </a>
      {upstreamFailing && <FailDot t={t} />}
    </span>
  );

  return (
    <Card isCompact isFullHeight>
      <CardHeader>
        <CardTitle>
          {proxy.label ? <strong>{proxy.label}</strong> : portLink}
        </CardTitle>
      </CardHeader>
      <CardBody>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem", fontSize: "0.85rem" }}>
          {proxy.label && portLink}

          {proxy.redirect ? (
            <>
              <code style={{ color: "var(--pf-t--global--text--color--subtle)" }}>
                → {proxy.redirect.to}
              </code>
              <div style={chipRow}>
                <Label isCompact color="purple">{t("proxies.type_redirect")}</Label>
                <Label isCompact color="purple" variant="outline">{proxy.redirect.code}</Label>
              </div>
            </>
          ) : proxy.fileServer ? (
            <>
              <code style={{ color: "var(--pf-t--global--text--color--subtle)" }}>
                {proxy.fileServer.root}
              </code>
              <div style={chipRow}>
                <Label isCompact color="green">{t("proxies.type_static")}</Label>
                {proxy.tls
                  ? <Label isCompact color="blue" variant="outline">{t("proxies.tls_self_signed")}</Label>
                  : <Label isCompact color="grey" variant="outline">{t("proxies.tls_none")}</Label>}
                {proxy.fileServer.browse && <Label isCompact color="teal" variant="outline">browse</Label>}
                {proxy.compress && <Label isCompact color="teal" variant="outline">{t("proxies.indicator_compress")}</Label>}
                {proxy.basicAuth?.length ? <Label isCompact color="red" variant="outline">{t("proxies.indicator_auth")}</Label> : null}
              </div>
            </>
          ) : (
            <>
              <code style={{ color: "var(--pf-t--global--text--color--subtle)" }}>
                → {proxy.targetScheme}://{proxy.targetHost}:{proxy.targetPort}
              </code>
              <div style={chipRow}>
                <Label isCompact color="blue">{t("proxies.type_proxy")}</Label>
                {proxy.tls
                  ? <Label isCompact color="blue" variant="outline">{t("proxies.tls_self_signed")}</Label>
                  : <Label isCompact color="grey" variant="outline">{t("proxies.tls_none")}</Label>}
                {proxy.tlsSkipVerify && <Label isCompact color="orange" variant="outline">{t("proxies.tls_skip_verify")}</Label>}
                {proxy.rewrite && <Label isCompact color="teal" variant="outline">{t(`rewrite.type_${proxy.rewrite.type}`)}</Label>}
                {proxy.compress && <Label isCompact color="teal" variant="outline">{t("proxies.indicator_compress")}</Label>}
                {proxy.basicAuth?.length ? <Label isCompact color="red" variant="outline">{t("proxies.indicator_auth")}</Label> : null}
                {(proxy.dialTimeout ?? proxy.responseHeaderTimeout) && <Label isCompact color="grey" variant="outline">{t("proxies.indicator_timeouts")}</Label>}
                {proxy.extraUpstreams?.length ? <Label isCompact color="blue" variant="outline">{t("proxies.indicator_lb")}</Label> : null}
              </div>
            </>
          )}
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
