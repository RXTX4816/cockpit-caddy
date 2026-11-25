import { useState } from "react";
import {
  Checkbox, ExpandableSection, FormGroup, FormHelperText, HelperText, HelperTextItem, TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { FileServerConfig, PhpFastcgiConfig } from "../api";

/** The static dialog's SPA and `file_server` options (#262), as edited: lists as typed text. */
export interface FileServerOptionsDraft {
  spa: boolean;
  index: string;
  hide: string;
  precompressed: string[];
  disableCanonicalUris: boolean;
  status: string;
  browseTemplate: string;
  templates: boolean;
  templatesMime: string;
  templatesRoot: string;
}

export const PRECOMPRESSED_FORMATS = ["zstd", "br", "gzip"] as const;

export function fileServerOptionsDraft(fs: FileServerConfig | undefined): FileServerOptionsDraft {
  return {
    spa: !!fs?.spa,
    index: fs?.index?.join(" ") ?? "",
    hide: fs?.hide?.join(" ") ?? "",
    precompressed: fs?.precompressed ?? [],
    disableCanonicalUris: !!fs?.disableCanonicalUris,
    status: fs?.status != null ? String(fs.status) : "",
    browseTemplate: fs?.browseTemplate ?? "",
    templates: !!fs?.templates,
    templatesMime: fs?.templates?.mime?.join(" ") ?? "",
    templatesRoot: fs?.templates?.root ?? "",
  };
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);

/** The options part of a FileServerConfig; unset options stay absent so old sites save unchanged. */
export function fileServerOptionsFromDraft(d: FileServerOptionsDraft): Pick<FileServerConfig, "spa" | "index" | "hide" | "precompressed" | "disableCanonicalUris" | "status" | "browseTemplate" | "templates"> {
  const out: Pick<FileServerConfig, "spa" | "index" | "hide" | "precompressed" | "disableCanonicalUris" | "status" | "browseTemplate" | "templates"> = {};
  if (d.disableCanonicalUris) out.disableCanonicalUris = true;
  const status = parseInt(d.status, 10);
  if (d.status.trim() && !isNaN(status)) out.status = status;
  if (d.browseTemplate.trim()) out.browseTemplate = d.browseTemplate.trim();
  if (d.templates) {
    out.templates = {
      ...(words(d.templatesMime).length ? { mime: words(d.templatesMime) } : {}),
      ...(d.templatesRoot.trim() ? { root: d.templatesRoot.trim() } : {}),
    };
  }
  if (d.spa) out.spa = true;
  if (words(d.index).length) out.index = words(d.index);
  if (words(d.hide).length) out.hide = words(d.hide);
  // The order is Caddy's preference order: keep the one the site already has (ticking a box
  // appends), so saving a hand-written `precompressed gzip br` doesn't reorder it.
  const pre = d.precompressed.filter((f, i, all) => all.indexOf(f) === i);
  if (pre.length) out.precompressed = pre;
  return out;
}

interface Props {
  idPrefix: string;
  value: FileServerOptionsDraft;
  onChange: (v: FileServerOptionsDraft) => void;
  isDisabled?: boolean;
}

/** SPA mode plus an expandable group with index files, hidden files and precompressed formats. */
export function FileServerOptionsFields({ idPrefix, value, onChange, isDisabled }: Props) {
  const { t } = useTranslation();
  const set = (patch: Partial<FileServerOptionsDraft>) => onChange({ ...value, ...patch });
  // Open from the start when a site already uses one of these options.
  const [expanded, setExpanded] = useState(() => !!(value.index.trim() || value.hide.trim() || value.precompressed.length || value.disableCanonicalUris || value.status.trim() || value.browseTemplate.trim() || value.templates));

  return (
    <>
      <FormGroup fieldId={`${idPrefix}-spa`}>
        <Checkbox
          id={`${idPrefix}-spa`}
          label={t("add_static.field_spa")}
          description={t("add_static.field_spa_help")}
          isChecked={value.spa}
          onChange={(_e, v) => set({ spa: v })}
          isDisabled={isDisabled}
        />
      </FormGroup>
      <ExpandableSection toggleText={t("add_static.advanced")} isIndented isExpanded={expanded} onToggle={(_e, v) => setExpanded(v)} data-testid={`${idPrefix}-advanced`}>
        <FormGroup label={t("add_static.field_index")} fieldId={`${idPrefix}-index`}>
          <TextInput
            id={`${idPrefix}-index`}
            value={value.index}
            onChange={(_e, v) => set({ index: v })}
            placeholder={t("common.default_value", { value: "index.html index.txt" })}
            isDisabled={isDisabled}
          />
          <FormHelperText><HelperText><HelperTextItem>{t("add_static.field_index_help")}</HelperTextItem></HelperText></FormHelperText>
        </FormGroup>
        <FormGroup label={t("add_static.field_hide")} fieldId={`${idPrefix}-hide`}>
          <TextInput
            id={`${idPrefix}-hide`}
            value={value.hide}
            onChange={(_e, v) => set({ hide: v })}
            placeholder=".git .env *.bak"
            isDisabled={isDisabled}
          />
          <FormHelperText><HelperText><HelperTextItem>{t("add_static.field_hide_help")}</HelperTextItem></HelperText></FormHelperText>
        </FormGroup>
        <FormGroup label={t("add_static.field_precompressed")} fieldId={`${idPrefix}-precompressed`} role="group" isInline>
          {PRECOMPRESSED_FORMATS.map(f => (
            <Checkbox
              key={f}
              id={`${idPrefix}-precompressed-${f}`}
              label={f}
              isChecked={value.precompressed.includes(f)}
              onChange={(_e, on) => set({ precompressed: on ? [...value.precompressed, f] : value.precompressed.filter(x => x !== f) })}
              isDisabled={isDisabled}
            />
          ))}
          <FormHelperText><HelperText><HelperTextItem>{t("add_static.field_precompressed_help")}</HelperTextItem></HelperText></FormHelperText>
        </FormGroup>
        <FormGroup label={t("add_static.field_browse_template")} fieldId={`${idPrefix}-browse-template`}>
          <TextInput
            id={`${idPrefix}-browse-template`}
            value={value.browseTemplate}
            onChange={(_e, v) => set({ browseTemplate: v })}
            placeholder="/etc/caddy/listing.html"
            isDisabled={isDisabled}
          />
          <FormHelperText><HelperText><HelperTextItem>{t("add_static.field_browse_template_help")}</HelperTextItem></HelperText></FormHelperText>
        </FormGroup>
        <FormGroup label={t("add_static.field_status")} fieldId={`${idPrefix}-status`}>
          <TextInput
            id={`${idPrefix}-status`}
            type="number"
            value={value.status}
            onChange={(_e, v) => set({ status: v })}
            placeholder="404"
            isDisabled={isDisabled}
          />
          <FormHelperText><HelperText><HelperTextItem>{t("add_static.field_status_help")}</HelperTextItem></HelperText></FormHelperText>
        </FormGroup>
        <FormGroup fieldId={`${idPrefix}-templates`}>
          <Checkbox
            id={`${idPrefix}-templates`}
            label={t("add_static.field_templates")}
            description={t("add_static.field_templates_help")}
            isChecked={value.templates}
            onChange={(_e, v) => set({ templates: v })}
            isDisabled={isDisabled}
          />
        </FormGroup>
        {value.templates && (
          <>
            <FormGroup label={t("add_static.field_templates_mime")} fieldId={`${idPrefix}-templates-mime`}>
              <TextInput
                id={`${idPrefix}-templates-mime`}
                value={value.templatesMime}
                onChange={(_e, v) => set({ templatesMime: v })}
                placeholder={t("common.default_value", { value: "text/html text/plain" })}
                isDisabled={isDisabled}
              />
            </FormGroup>
            <FormGroup label={t("add_static.field_templates_root")} fieldId={`${idPrefix}-templates-root`}>
              <TextInput
                id={`${idPrefix}-templates-root`}
                value={value.templatesRoot}
                onChange={(_e, v) => set({ templatesRoot: v })}
                placeholder="/srv/includes"
                isDisabled={isDisabled}
              />
              <FormHelperText><HelperText><HelperTextItem>{t("add_static.field_templates_root_help")}</HelperTextItem></HelperText></FormHelperText>
            </FormGroup>
          </>
        )}
        <FormGroup fieldId={`${idPrefix}-canonical-uris`}>
          <Checkbox
            id={`${idPrefix}-canonical-uris`}
            label={t("add_static.field_disable_canonical_uris")}
            description={t("add_static.field_disable_canonical_uris_help")}
            isChecked={value.disableCanonicalUris}
            onChange={(_e, v) => set({ disableCanonicalUris: v })}
            isDisabled={isDisabled}
          />
        </FormGroup>
      </ExpandableSection>
    </>
  );
}

/** PHP sites' optional `try_files` (#262); the usual front-controller line is only a hint. */
export function PhpTryFilesField({ id, value, onChange, isDisabled }: { id: string; value: string; onChange: (v: string) => void; isDisabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <FormGroup label={t("php_fastcgi.field_try_files")} fieldId={id}>
      <TextInput id={id} value={value} onChange={(_e, v) => onChange(v)} placeholder="{path} {path}/ /index.php?{query}" isDisabled={isDisabled} />
      <FormHelperText><HelperText><HelperTextItem>{t("php_fastcgi.field_try_files_help")}</HelperTextItem></HelperText></FormHelperText>
    </FormGroup>
  );
}


/** The php_fastcgi options of #340, as edited: timeouts as typed text. */
export interface PhpOptionsDraft {
  captureStderr: boolean;
  resolveRootSymlink: boolean;
  dialTimeout: string;
  readTimeout: string;
  writeTimeout: string;
}

export function phpOptionsDraft(php: PhpFastcgiConfig | undefined): PhpOptionsDraft {
  return {
    captureStderr: !!php?.captureStderr,
    resolveRootSymlink: !!php?.resolveRootSymlink,
    dialTimeout: php?.dialTimeout ?? "",
    readTimeout: php?.readTimeout ?? "",
    writeTimeout: php?.writeTimeout ?? "",
  };
}

const DURATION = /^\d+(\.\d+)?(ns|us|ms|s|m|h)$/;

export function phpOptionsFromDraft(d: PhpOptionsDraft): Pick<PhpFastcgiConfig, "captureStderr" | "resolveRootSymlink" | "dialTimeout" | "readTimeout" | "writeTimeout"> {
  return {
    captureStderr: d.captureStderr || undefined,
    resolveRootSymlink: d.resolveRootSymlink || undefined,
    dialTimeout: d.dialTimeout.trim() || undefined,
    readTimeout: d.readTimeout.trim() || undefined,
    writeTimeout: d.writeTimeout.trim() || undefined,
  };
}

/** A timeout Caddy would not read as a duration. */
export function phpOptionsHaveErrors(d: PhpOptionsDraft): boolean {
  return [d.dialTimeout, d.readTimeout, d.writeTimeout].some(v => v.trim() && !DURATION.test(v.trim()));
}

export function PhpOptionsFields({ idPrefix, value, onChange, isDisabled }: { idPrefix: string; value: PhpOptionsDraft; onChange: (v: PhpOptionsDraft) => void; isDisabled?: boolean }) {
  const { t } = useTranslation();
  const set = (patch: Partial<PhpOptionsDraft>) => onChange({ ...value, ...patch });
  const [expanded, setExpanded] = useState(() => !!(value.captureStderr || value.resolveRootSymlink || value.dialTimeout || value.readTimeout || value.writeTimeout));
  const timeouts: Array<["dialTimeout" | "readTimeout" | "writeTimeout", string]> = [
    ["dialTimeout", "php_fastcgi.field_dial_timeout"], ["readTimeout", "php_fastcgi.field_read_timeout"], ["writeTimeout", "php_fastcgi.field_write_timeout"],
  ];
  return (
    <ExpandableSection toggleText={t("add_static.advanced")} isIndented isExpanded={expanded} onToggle={(_e, v) => setExpanded(v)} data-testid={`${idPrefix}-advanced`}>
      {timeouts.map(([key, label]) => {
        const bad = !!value[key].trim() && !DURATION.test(value[key].trim());
        return (
          <FormGroup key={key} label={t(label)} fieldId={`${idPrefix}-${key}`}>
            <TextInput
              id={`${idPrefix}-${key}`}
              value={value[key]}
              onChange={(_e, v) => set({ [key]: v })}
              placeholder={t("common.default_value", { value: key === "dialTimeout" ? "3s" : t("php_fastcgi.no_timeout") })}
              validated={bad ? "error" : "default"}
              isDisabled={isDisabled}
            />
            {bad && <FormHelperText><HelperText><HelperTextItem variant="error">{t("global_opts.validation_duration")}</HelperTextItem></HelperText></FormHelperText>}
          </FormGroup>
        );
      })}
      <FormGroup fieldId={`${idPrefix}-capture-stderr`}>
        <Checkbox
          id={`${idPrefix}-capture-stderr`}
          label={t("php_fastcgi.field_capture_stderr")}
          description={t("php_fastcgi.field_capture_stderr_help")}
          isChecked={value.captureStderr}
          onChange={(_e, v) => set({ captureStderr: v })}
          isDisabled={isDisabled}
        />
      </FormGroup>
      <FormGroup fieldId={`${idPrefix}-resolve-symlink`}>
        <Checkbox
          id={`${idPrefix}-resolve-symlink`}
          label={t("php_fastcgi.field_resolve_root_symlink")}
          description={t("php_fastcgi.field_resolve_root_symlink_help")}
          isChecked={value.resolveRootSymlink}
          onChange={(_e, v) => set({ resolveRootSymlink: v })}
          isDisabled={isDisabled}
        />
      </FormGroup>
    </ExpandableSection>
  );
}
