import { useState } from "react";
import {
  Checkbox, ExpandableSection, FormGroup, FormHelperText, HelperText, HelperTextItem, TextInput,
} from "@patternfly/react-core";
import { useTranslation } from "react-i18next";
import type { FileServerConfig } from "../api";

/** The static dialog's SPA and `file_server` options (#262), as edited: lists as typed text. */
export interface FileServerOptionsDraft {
  spa: boolean;
  index: string;
  hide: string;
  precompressed: string[];
}

export const PRECOMPRESSED_FORMATS = ["zstd", "br", "gzip"] as const;

export function fileServerOptionsDraft(fs: FileServerConfig | undefined): FileServerOptionsDraft {
  return {
    spa: !!fs?.spa,
    index: fs?.index?.join(" ") ?? "",
    hide: fs?.hide?.join(" ") ?? "",
    precompressed: fs?.precompressed ?? [],
  };
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);

/** The options part of a FileServerConfig; unset options stay absent so old sites save unchanged. */
export function fileServerOptionsFromDraft(d: FileServerOptionsDraft): Pick<FileServerConfig, "spa" | "index" | "hide" | "precompressed"> {
  const out: Pick<FileServerConfig, "spa" | "index" | "hide" | "precompressed"> = {};
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
  const [expanded, setExpanded] = useState(() => !!(value.index.trim() || value.hide.trim() || value.precompressed.length));

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
