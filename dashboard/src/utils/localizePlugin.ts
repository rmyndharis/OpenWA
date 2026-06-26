import type { PluginConfigSchema, PluginI18n, PluginI18nLocale } from '../services/api';

function localizeConfigSchema(
  schema: PluginConfigSchema | undefined,
  config: PluginI18nLocale['config'] | undefined,
): PluginConfigSchema | undefined {
  if (!schema?.properties || !config || typeof config !== 'object') return schema;
  const properties: PluginConfigSchema['properties'] = {};
  for (const [key, field] of Object.entries(schema.properties)) {
    const ov = config[key];
    properties[key] = ov
      ? { ...field, title: ov.title ?? field.title, description: ov.description ?? field.description }
      : field;
  }
  return { ...schema, properties };
}

/** Return a localized view of `plugin` for `lang`; identity when there is no matching override. */
export function localizePlugin<
  T extends { name: string; description?: string; configSchema?: PluginConfigSchema; i18n?: PluginI18n },
>(plugin: T, lang: string): T {
  const ov = plugin.i18n && typeof plugin.i18n === 'object' ? plugin.i18n[lang] : undefined;
  if (!ov || typeof ov !== 'object') return plugin;
  return {
    ...plugin,
    name: ov.name ?? plugin.name,
    description: ov.description ?? plugin.description,
    configSchema: localizeConfigSchema(plugin.configSchema, ov.config),
  };
}
