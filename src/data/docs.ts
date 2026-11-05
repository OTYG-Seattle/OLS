export const docsParentCategories = [
  {
    slug: 'specification',
    name: 'Specification',
    description: 'OLS v1.0 standard technical specification, rules, and core concepts.',
  },
  {
    slug: 'liturgical-elements',
    name: 'Liturgical Data Model',
    description: 'Entities and relations for encoding liturgy: utterances, music, rubrics, and calendars.',
  },
  {
    slug: 'advanced-profiles',
    name: 'Advanced & Profiles',
    description: 'Scholarly tools, JSON schema validation, conformance, and tradition-specific profiles.',
  },
] as const;

export const docsCategories = [
  {
    name: 'Introduction',
    slug: 'introduction',
    parent: 'specification',
    description: 'Core overview, document status, scope, package layout, and referencing rules.',
    icon: 'flag',
  },
  {
    name: 'Metadata & Authority',
    slug: 'metadata-authority',
    parent: 'specification',
    description: 'Ecclesial review, authority status, and source provenance/citations.',
    icon: 'file',
  },
  {
    name: 'Core Data Model',
    slug: 'data-model',
    parent: 'liturgical-elements',
    description: 'Fundamental structures, localized text, and liturgical role definitions.',
    icon: 'spark',
  },
  {
    name: 'Liturgical Elements',
    slug: 'content-types',
    parent: 'liturgical-elements',
    description: 'Text utterances, scripture readings, chant/music, and performable rubrics.',
    icon: 'grid',
  },
  {
    name: 'Space & Actions',
    slug: 'space-actions',
    parent: 'liturgical-elements',
    description: 'Sacred space rules, rubric state machines, and proper structural mutations.',
    icon: 'flag',
  },
  {
    name: 'Ordo & Calendar',
    slug: 'ordo-calendar',
    parent: 'liturgical-elements',
    description: 'Service templates (Ordos), liturgical calendar resolution, and ServiceInstances.',
    icon: 'file',
  },
  {
    name: 'Scholarly & Media',
    slug: 'advanced-features',
    parent: 'advanced-profiles',
    description: 'Variants apparatus, commentary/teaching annotations, and linked media assets.',
    icon: 'spark',
  },
  {
    name: 'Schemas & Governance',
    slug: 'conformance-schemas',
    parent: 'advanced-profiles',
    description: 'JSON Schema specifications, validation levels, test fixtures, and technical governance.',
    icon: 'grid',
  },
  {
    name: 'Sharing & Distribution',
    slug: 'distribution',
    parent: 'advanced-profiles',
    description: 'Canonical form, digests, and tooling for publishing packages other parties can rely on.',
    icon: 'inbox',
  },
  {
    name: 'Profiles & Examples',
    slug: 'profiles-examples',
    parent: 'advanced-profiles',
    description: 'Tradition-specific profiles (EOTC, Oriental Orthodox) and complete corpus examples.',
    icon: 'flag',
  },
] as const;

export type DocsParentSlug = (typeof docsParentCategories)[number]['slug'];
export type DocsCategorySlug = (typeof docsCategories)[number]['slug'];

export const docsCategorySlugs = docsCategories.map((category) => category.slug) as [
  DocsCategorySlug,
  ...DocsCategorySlug[],
];

export const docsParentMap = Object.fromEntries(
  docsParentCategories.map((category) => [category.slug, category]),
) as Record<DocsParentSlug, (typeof docsParentCategories)[number]>;

export const docsCategoryMap = Object.fromEntries(
  docsCategories.map((category) => [category.slug, category.name]),
) as Record<DocsCategorySlug, string>;

export const docsCategoryDataMap = Object.fromEntries(
  docsCategories.map((category) => [category.slug, category]),
) as Record<DocsCategorySlug, (typeof docsCategories)[number]>;

export function getParentForCategory(categorySlug: string) {
  return docsCategories.find((category) => category.slug === categorySlug)?.parent;
}

export function getCategoriesForParent(parentSlug: string) {
  return docsCategories.filter((category) => category.parent === parentSlug);
}

export function getCategoryHref(categorySlug: string) {
  const parentSlug = getParentForCategory(categorySlug);
  return parentSlug ? `/${parentSlug}/${categorySlug}` : `/${categorySlug}`;
}

export type SidebarSection = {
  name: string;
  slug: string;
  href: string;
};

export function getSidebarSections(parentSlug: string): SidebarSection[] {
  return getCategoriesForParent(parentSlug).map((section) => ({
    name: section.name,
    slug: section.slug,
    href: getCategoryHref(section.slug),
  }));
}

export function getArticleHref(categorySlug: string, articleSlug: string) {
  return `${getCategoryHref(categorySlug)}/${articleSlug}`;
}

export function getCleanDocSlug(docId: string) {
  return docId.split('/').at(-1) ?? docId;
}

type PublicDocSource = {
  data: {
    status?: string;
  };
};

type SearchSuggestionSource = {
  id: string;
  data: {
    title: string;
    description?: string;
    category: string;
    order?: number;
    hideFromSearch?: boolean;
    status?: string;
  };
};

type OrderedDocSource = {
  data: {
    category: string;
    order?: number;
    status?: string;
  };
};

export type SearchSuggestion = {
  title: string;
  excerpt: string;
  url: string;
};

const SEARCH_PREVIEW_MAX_CHARS = 160;

export function isPublicDoc<T extends PublicDocSource>(doc: T) {
  return doc.data.status !== 'draft' && doc.data.status !== 'archived';
}

export function getPublicDocs<T extends PublicDocSource>(docs: T[]) {
  return docs.filter(isPublicDoc);
}

const clampText = (value: string, maxChars = SEARCH_PREVIEW_MAX_CHARS) => {
  if (value.length <= maxChars) return value;

  const truncated = value.slice(0, maxChars);
  const lastSpaceIndex = truncated.lastIndexOf(' ');

  return `${(lastSpaceIndex > 60 ? truncated.slice(0, lastSpaceIndex) : truncated).trimEnd()}...`;
};

export function getDocSearchPreview(doc: SearchSuggestionSource, maxChars = SEARCH_PREVIEW_MAX_CHARS) {
  return clampText(doc.data.description?.trim() ?? '', maxChars);
}

export function getSearchPreviewLookup(docs: SearchSuggestionSource[]) {
  return Object.fromEntries(
    getPublicDocs(docs).map((doc) => [
      getArticleHref(doc.data.category, getCleanDocSlug(doc.id)),
      getDocSearchPreview(doc),
    ]),
  ) as Record<string, string>;
}

export function getSuggestedSearchArticles(
  docs: SearchSuggestionSource[],
  { limit = 4, categories = ['introduction'] }: { limit?: number; categories?: string[] } = {},
): SearchSuggestion[] {
  const allowedCategories = new Set(categories);

  return docs
    .filter(isPublicDoc)
    .filter((doc) => !doc.data.hideFromSearch)
    .filter((doc) => allowedCategories.has(doc.data.category))
    .sort((a, b) => {
      const categoryIndexDifference = categories.indexOf(a.data.category) - categories.indexOf(b.data.category);
      if (categoryIndexDifference !== 0) return categoryIndexDifference;
      return (a.data.order ?? 100) - (b.data.order ?? 100);
    })
    .slice(0, limit)
    .map((doc) => ({
      title: doc.data.title,
      excerpt: getDocSearchPreview(doc),
      url: getArticleHref(doc.data.category, getCleanDocSlug(doc.id)),
    }));
}

export function getOrderedDocsForCategory<T extends OrderedDocSource>(docs: T[], category: string) {
  return docs
    .filter(isPublicDoc)
    .filter((doc) => doc.data.category === category)
    .sort((a, b) => (a.data.order ?? 100) - (b.data.order ?? 100));
}
