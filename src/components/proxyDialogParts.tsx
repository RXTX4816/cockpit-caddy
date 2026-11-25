import { useState, type ReactNode, type Ref } from "react";
import {
  Checkbox,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  InputGroupText,
  MenuToggle,
  Select,
  SelectList,
  SelectOption,
  Tab,
  Tabs,
  TabTitleText,
  TextInput,
  ToggleGroup,
  ToggleGroupItem,
  type MenuToggleElement,
} from "@patternfly/react-core";
import { ExclamationCircleIcon } from "@patternfly/react-icons";
import { useTranslation } from "react-i18next";
import { FlatSectionsContext } from "./sectionLayout";

export type ProxyTabKey = "general" | "security" | "routing" | "upstreams" | "logging" | "limits" | "tree";
export const PROXY_TAB_ORDER: ProxyTabKey[] = ["general", "security", "routing", "upstreams", "logging", "limits", "tree"];

export interface ProxyTab<K extends string = ProxyTabKey> {
  key: K;
  /** The tab's title when it has no `proxy_tabs.<key>` entry (Settings, #346). */
  label?: string;
  /** Something in the tab differs from the defaults (not shown for General). */
  configured?: boolean;
  hasError?: boolean;
  content: ReactNode;
}

/** The first tab holding a validation error, so Save can jump to it (#260). */
export function firstTabWithError(hasError: Record<ProxyTabKey, boolean>): ProxyTabKey | undefined {
  return PROXY_TAB_ORDER.find(k => hasError[k]);
}

/**
 * The proxy dialog's tabs (#260): General, Security, Routing, Upstreams, Logging & errors, Limits (#292). A tab
 * shows a dot when something in it is configured and an error icon when it holds an error. The
 * sections inside render as plain field groups (FlatSectionsContext).
 */
export function ProxyDialogTabs<K extends string = ProxyTabKey>({ tabs, active, onSelect, ariaLabel }: { tabs: ProxyTab<K>[]; active: K; onSelect: (k: K) => void; ariaLabel?: string }) {
  const { t } = useTranslation();
  return (
    <FlatSectionsContext.Provider value>
      <Tabs activeKey={active} onSelect={(_e, k) => onSelect(k as K)} aria-label={ariaLabel ?? t("proxy_tabs.aria_label")} mountOnEnter={false}>
        {tabs.map(tab => (
          <Tab
            key={tab.key}
            eventKey={tab.key}
            title={
              <TabTitleText>
                {tab.label ?? t(`proxy_tabs.${tab.key as ProxyTabKey}`)}
                {tab.hasError ? (
                  <ExclamationCircleIcon
                    title={t("proxy_tabs.has_error")}
                    style={{ marginLeft: "0.4rem", color: "var(--pf-t--global--icon--color--status--danger--default)" }}
                  />
                ) : tab.configured && tab.key !== "general" ? (
                  <span
                    role="img"
                    aria-label={t("common.configured")}
                    title={t("common.configured")}
                    style={{ display: "inline-block", width: "0.5rem", height: "0.5rem", borderRadius: "50%", marginLeft: "0.4rem", verticalAlign: "middle", background: "var(--pf-t--global--icon--color--status--info--default, #2b9af3)" }}
                  />
                ) : null}
              </TabTitleText>
            }
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem", paddingTop: "1rem" }}>{tab.content}</div>
          </Tab>
        ))}
      </Tabs>
    </FlatSectionsContext.Provider>
  );
}

interface AddressProps {
  scheme: string;
  onSchemeChange: (v: string) => void;
  host: string;
  onHostChange: (v: string) => void;
  port: string;
  onPortChange: (v: string) => void;
  builtinSchemes: string[];
  suggestedSchemes: string[];
  isDisabled?: boolean;
  hostError?: boolean;
  portError?: boolean;
}

/** `[scheme ▾] [host] : [port]` in one row (#260). */
export function InlineAddressField({ scheme, onSchemeChange, host, onHostChange, port, onPortChange, builtinSchemes, suggestedSchemes, isDisabled, hostError, portError }: AddressProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const presets = [...builtinSchemes, ...suggestedSchemes.filter(s => !builtinSchemes.includes(s))];
  const [custom, setCustom] = useState(() => scheme !== "" && !presets.includes(scheme));
  const label = custom ? t("add_proxy.ext_scheme_custom") : scheme || t("add_proxy.ext_scheme_none");

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.25rem", minWidth: 0 }}>
      <Select
        isOpen={open}
        selected={custom ? "__custom__" : scheme}
        onOpenChange={setOpen}
        onSelect={(_e, v) => {
          const val = String(v ?? "");
          setCustom(val === "__custom__");
          onSchemeChange(val === "__custom__" ? "" : val);
          setOpen(false);
        }}
        toggle={(ref: Ref<MenuToggleElement>) => (
          <MenuToggle ref={ref} onClick={() => setOpen(o => !o)} isExpanded={open} isDisabled={isDisabled} aria-label={t("add_proxy.ext_scheme_label")} style={{ flexShrink: 0, minWidth: "7rem" }}>
            {label}
          </MenuToggle>
        )}
      >
        <SelectList>
          <SelectOption value="">{t("add_proxy.ext_scheme_none")}</SelectOption>
          {presets.map(s => <SelectOption key={s} value={s}>{s}</SelectOption>)}
          <SelectOption value="__custom__">{t("add_proxy.ext_scheme_custom")}</SelectOption>
        </SelectList>
      </Select>
      {custom && (
        <TextInput aria-label={t("add_proxy.ext_scheme_custom_input")} value={scheme} onChange={(_e, v) => onSchemeChange(v)} isDisabled={isDisabled} style={{ width: "5rem", flexShrink: 0 }} />
      )}
      <TextInput
        aria-label={t("add_proxy.ext_host_label")}
        value={host}
        onChange={(_e, v) => onHostChange(v)}
        isDisabled={isDisabled}
        validated={hostError ? "error" : "default"}
        placeholder={t("add_proxy.ext_host_placeholder")}
        style={{ flex: 1, minWidth: "8rem" }}
      />
      <InputGroupText style={{ flexShrink: 0 }}>:</InputGroupText>
      <TextInput
        aria-label={t("add_proxy.ext_port_label")}
        type="number"
        value={port}
        onChange={(_e, v) => onPortChange(v)}
        isDisabled={isDisabled}
        validated={portError ? "error" : "default"}
        placeholder={t("add_proxy.ext_port_placeholder")}
        style={{ width: "8rem", flexShrink: 0 }}
      />
    </div>
  );
}

interface TargetProps {
  idPrefix: string;
  scheme: "http" | "https";
  onSchemeChange: (v: "http" | "https") => void;
  host: string;
  onHostChange: (v: string) => void;
  port: string;
  onPortChange: (v: string) => void;
  skipVerify: boolean;
  onSkipVerifyChange: (v: boolean) => void;
  hostError?: string;
  portError?: string;
  isDisabled?: boolean;
}

/** Target: an http | https toggle, host and port (#260), each validated on its own. */
export function TargetField({ idPrefix, scheme, onSchemeChange, host, onHostChange, port, onPortChange, skipVerify, onSkipVerifyChange, hostError, portError, isDisabled }: TargetProps) {
  const { t } = useTranslation();
  return (
    <FormGroup label={t("add_proxy.field_target_host")} fieldId={`${idPrefix}target-host`} isRequired>
      <div style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
        {/* Without flexShrink: 0 the group gets squeezed to one letter per line next to the host field. */}
        <ToggleGroup aria-label={t("add_proxy.target_scheme_label")} style={{ flexShrink: 0 }}>
          <ToggleGroupItem text="http" buttonId={`${idPrefix}target-http`} isSelected={scheme === "http"} onChange={() => onSchemeChange("http")} isDisabled={isDisabled} />
          <ToggleGroupItem text="https" buttonId={`${idPrefix}target-https`} isSelected={scheme === "https"} onChange={() => onSchemeChange("https")} isDisabled={isDisabled} />
        </ToggleGroup>
        <TextInput
          id={`${idPrefix}target-host`}
          value={host}
          onChange={(_e, v) => onHostChange(v)}
          placeholder={t("add_proxy.field_target_host_placeholder")}
          isDisabled={isDisabled}
          validated={hostError ? "error" : "default"}
          style={{ flex: 1, minWidth: "8rem" }}
        />
        <InputGroupText style={{ flexShrink: 0 }}>:</InputGroupText>
        <TextInput
          id={`${idPrefix}target-port`}
          aria-label={t("add_proxy.target_port_label")}
          type="number"
          value={port}
          onChange={(_e, v) => onPortChange(v)}
          placeholder={t("add_proxy.target_port_placeholder")}
          isDisabled={isDisabled}
          validated={portError ? "error" : "default"}
          style={{ width: "8rem", flexShrink: 0 }}
        />
      </div>
      {(hostError || portError) && (
        <FormHelperText>
          <HelperText>
            {hostError && <HelperTextItem variant="error">{hostError}</HelperTextItem>}
            {portError && <HelperTextItem variant="error">{portError}</HelperTextItem>}
          </HelperText>
        </FormHelperText>
      )}
      {scheme === "https" && (
        <Checkbox
          id={`${idPrefix}tls-skip-verify`}
          label={t("add_proxy.field_tls_skip_verify")}
          isChecked={skipVerify}
          onChange={(_e, checked) => onSkipVerifyChange(checked)}
          isDisabled={isDisabled}
          style={{ marginTop: "0.4rem" }}
        />
      )}
    </FormGroup>
  );
}

/** "Register as named route (invoke)" with a one-line explanation (#260). */
export function NamedRouteField({ idPrefix, enabled, onEnabledChange, name, onNameChange, isDisabled }: {
  idPrefix: string; enabled: boolean; onEnabledChange: (v: boolean) => void; name: string; onNameChange: (v: string) => void; isDisabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
      <Checkbox
        id={`${idPrefix}named-route`}
        label={t("named_route.toggle_label")}
        description={t("named_route.help")}
        isChecked={enabled}
        onChange={(_e, v) => { onEnabledChange(v); if (!v) onNameChange(""); }}
        isDisabled={isDisabled}
      />
      {enabled && (
        <TextInput
          id={`${idPrefix}named-route-name`}
          aria-label={t("named_route.name_label")}
          placeholder={t("named_route.name_placeholder")}
          value={name}
          onChange={(_e, v) => onNameChange(v)}
          isDisabled={isDisabled}
          style={{ maxWidth: "20rem" }}
        />
      )}
    </div>
  );
}
