import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioWaveform,
  BookOpen,
  Download,
  FolderOpen,
  HelpCircle,
  Keyboard,
  Lightbulb,
  ListMusic,
  Search,
  Sliders,
  Sparkles,
  X,
} from 'lucide-react';
import {
  HELP_SECTIONS,
  KEYBOARD_SHORTCUTS,
  type HelpArticle,
  type HelpCategoryId,
  type KeyboardShortcutItem,
} from '../data/helpContent';

interface HelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const CATEGORY_ICONS: Record<HelpCategoryId, React.ReactNode> = {
  'quick-start': <Sparkles className="w-3.5 h-3.5 shrink-0" />,
  'dj-folder': <FolderOpen className="w-3.5 h-3.5 shrink-0" />,
  'playlist-beatgrid': <ListMusic className="w-3.5 h-3.5 shrink-0" />,
  'timeline-mixing': <AudioWaveform className="w-3.5 h-3.5 shrink-0" />,
  'tempo-fx': <Sliders className="w-3.5 h-3.5 shrink-0" />,
  'projects-export': <Download className="w-3.5 h-3.5 shrink-0" />,
  shortcuts: <Keyboard className="w-3.5 h-3.5 shrink-0" />,
};

const SHORTCUT_GROUPS: ReadonlyArray<KeyboardShortcutItem['context']> = [
  'Global Timeline',
  'Beatgrid Editor',
  'Beat Edit Window',
  'Controls',
];

function articleMatchesQuery(article: HelpArticle, sectionTitle: string, q: string): boolean {
  const haystack = [
    sectionTitle,
    article.title,
    article.summary,
    ...(article.steps ?? []),
    ...(article.tips ?? []),
    ...article.keywords,
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

function shortcutMatchesQuery(item: KeyboardShortcutItem, q: string): boolean {
  const haystack = [item.context, item.action, ...item.keys].join(' ').toLowerCase();
  return haystack.includes(q);
}

export const HelpModal: React.FC<HelpModalProps> = ({ isOpen, onClose }) => {
  const [activeCategory, setActiveCategory] = useState<HelpCategoryId>('quick-start');
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    setSearchQuery('');
    const timer = window.setTimeout(() => {
      searchInputRef.current?.focus();
    }, 30);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen]);

  useEffect(() => {
    contentScrollRef.current?.scrollTo({ top: 0 });
  }, [activeCategory, searchQuery]);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const isSearching = normalizedQuery.length > 0;

  const searchResults = useMemo(() => {
    if (!isSearching) return null;

    const matchedArticles: Array<{ sectionTitle: string; article: HelpArticle }> = [];
    for (const section of HELP_SECTIONS) {
      for (const article of section.articles) {
        if (articleMatchesQuery(article, section.title, normalizedQuery)) {
          matchedArticles.push({ sectionTitle: section.title, article });
        }
      }
    }

    const matchedShortcuts = KEYBOARD_SHORTCUTS.filter((item) =>
      shortcutMatchesQuery(item, normalizedQuery)
    );

    return { matchedArticles, matchedShortcuts };
  }, [isSearching, normalizedQuery]);

  const activeSection = useMemo(
    () => HELP_SECTIONS.find((s) => s.id === activeCategory) ?? HELP_SECTIONS[0],
    [activeCategory]
  );

  if (!isOpen) return null;

  const renderArticleCard = (article: HelpArticle, badge?: string) => (
    <article
      key={article.id}
      className="rounded-md bg-om-well border border-white/[0.08] p-4 flex flex-col gap-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          {badge && (
            <div className="text-[10px] font-semibold uppercase tracking-wider text-om-accent mb-1">
              {badge}
            </div>
          )}
          <h4 className="font-display text-sm font-semibold text-om-text">{article.title}</h4>
          <p className="text-xs text-om-text-secondary leading-relaxed mt-1">{article.summary}</p>
        </div>
      </div>

      {article.steps && article.steps.length > 0 && (
        <ol className="flex flex-col gap-1.5 text-xs text-om-text-secondary leading-relaxed">
          {article.steps.map((step, idx) => (
            <li key={idx} className="flex items-start gap-2.5">
              <span className="w-4 h-4 rounded bg-om-control border border-white/[0.08] text-[10px] font-mono font-semibold text-om-accent inline-flex items-center justify-center shrink-0 mt-0.5 tabular-nums">
                {idx + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      )}

      {article.tips && article.tips.length > 0 && (
        <div className="rounded bg-om-elevated/80 border border-om-accent/20 px-3 py-2 flex flex-col gap-1.5">
          {article.tips.map((tip, idx) => (
            <div key={idx} className="flex items-start gap-2 text-[11px] text-om-text-muted leading-relaxed">
              <Lightbulb className="w-3.5 h-3.5 text-om-accent shrink-0 mt-0.5" />
              <span>{tip}</span>
            </div>
          ))}
        </div>
      )}
    </article>
  );

  const renderShortcutRow = (item: KeyboardShortcutItem, idx: number) => (
    <div
      key={`${item.context}-${idx}`}
      className="px-3.5 py-2 flex items-center justify-between gap-4 border-b border-white/[0.06] last:border-b-0"
    >
      <span className="text-xs text-om-text-secondary">{item.action}</span>
      <div className="flex items-center gap-1 shrink-0">
        {item.keys.map((keyLabel, keyIdx) => (
          <React.Fragment key={keyIdx}>
            {keyIdx > 0 && <span className="text-[10px] text-om-text-faint">/</span>}
            <kbd className="px-1.5 py-0.5 rounded bg-om-control border border-white/[0.12] font-mono text-[11px] font-medium text-om-text shadow-xs">
              {keyLabel}
            </kbd>
          </React.Fragment>
        ))}
      </div>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="help-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-[820px] h-[min(640px,86vh)] bg-om-panel border border-white/[0.12] rounded-lg shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-white/[0.08] flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <HelpCircle className="w-4 h-4 text-om-accent shrink-0" />
            <div className="min-w-0">
              <h3
                id="help-modal-title"
                className="font-display text-base font-semibold text-om-text truncate"
              >
                OpenMix Studio Help Center
              </h3>
              <p className="text-xs text-om-text-subtle mt-0.5">
                Workflow guides, mixing tips, and keyboard shortcuts
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {/* Search Box */}
            <div className="relative w-52 sm:w-64">
              <Search className="w-3.5 h-3.5 text-om-text-subtle absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search help & shortcuts..."
                aria-label="Search help topics and shortcuts"
                className="w-full pl-8 pr-7 py-1.5 rounded-md bg-om-base border border-white/[0.1] focus:border-om-accent/70 text-xs text-om-text placeholder:text-om-text-faint focus:outline-none"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search"
                  className="p-0.5 text-om-text-subtle hover:text-white absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label="Close Help Center"
              className="p-1 text-om-text-subtle hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body Split: Sidebar Navigation + Scrollable Article Pane */}
        <div className="flex-1 min-h-0 flex flex-col sm:flex-row overflow-hidden">
          {/* Category Navigation */}
          <nav
            aria-label="Help topics"
            className="sm:w-52 shrink-0 bg-om-sub border-b sm:border-b-0 sm:border-r border-white/[0.08] p-2 flex sm:flex-col gap-1 overflow-x-auto sm:overflow-y-auto"
          >
            <div className="hidden sm:flex items-center gap-1.5 px-2.5 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-om-text-subtle">
              <BookOpen className="w-3 h-3" />
              <span>Guides</span>
            </div>

            {HELP_SECTIONS.map((section) => {
              const isActive = !isSearching && activeCategory === section.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setActiveCategory(section.id);
                  }}
                  className={`px-2.5 py-2 rounded-md text-xs font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 text-left cursor-pointer ${
                    isActive
                      ? 'bg-om-control text-om-text border border-om-accent/40'
                      : 'text-om-text-muted hover:text-om-text hover:bg-om-control/60 border border-transparent'
                  }`}
                >
                  <span className={isActive ? 'text-om-accent' : 'text-om-text-dim'}>
                    {CATEGORY_ICONS[section.id]}
                  </span>
                  <span className="truncate">{section.shortTitle}</span>
                </button>
              );
            })}

            <div className="hidden sm:block my-1.5 border-t border-white/[0.08]" />

            <button
              type="button"
              onClick={() => {
                setSearchQuery('');
                setActiveCategory('shortcuts');
              }}
              className={`px-2.5 py-2 rounded-md text-xs font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 text-left cursor-pointer ${
                !isSearching && activeCategory === 'shortcuts'
                  ? 'bg-om-control text-om-text border border-om-accent/40'
                  : 'text-om-text-muted hover:text-om-text hover:bg-om-control/60 border border-transparent'
              }`}
            >
              <span
                className={
                  !isSearching && activeCategory === 'shortcuts'
                    ? 'text-om-accent'
                    : 'text-om-text-dim'
                }
              >
                {CATEGORY_ICONS.shortcuts}
              </span>
              <span>Shortcuts</span>
            </button>
          </nav>

          {/* Main Content Area */}
          <div
            ref={contentScrollRef}
            className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-4"
          >
            {isSearching && searchResults ? (
              <>
                <div className="flex items-center justify-between gap-2 pb-2 border-b border-white/[0.08]">
                  <h4 className="font-display text-sm font-semibold text-om-text">
                    Search results for &ldquo;{searchQuery.trim()}&rdquo;
                  </h4>
                  <span className="text-[11px] font-mono text-om-text-subtle tabular-nums">
                    {searchResults.matchedArticles.length + searchResults.matchedShortcuts.length}{' '}
                    matches
                  </span>
                </div>

                {searchResults.matchedArticles.length === 0 &&
                searchResults.matchedShortcuts.length === 0 ? (
                  <div className="py-12 text-center flex flex-col items-center gap-2">
                    <Search className="w-5 h-5 text-om-text-faint" />
                    <p className="text-xs text-om-text-muted">
                      No help topics or shortcuts matched &ldquo;{searchQuery.trim()}&rdquo;.
                    </p>
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="text-xs font-medium text-om-accent hover:text-om-accent-bright cursor-pointer"
                    >
                      Clear search
                    </button>
                  </div>
                ) : (
                  <>
                    {searchResults.matchedArticles.length > 0 && (
                      <div className="flex flex-col gap-3">
                        {searchResults.matchedArticles.map(({ sectionTitle, article }) =>
                          renderArticleCard(article, sectionTitle)
                        )}
                      </div>
                    )}

                    {searchResults.matchedShortcuts.length > 0 && (
                      <div className="rounded-md bg-om-well border border-white/[0.08] overflow-hidden">
                        <div className="px-3.5 py-2 bg-om-sub border-b border-white/[0.08] text-[11px] font-semibold uppercase tracking-wider text-om-accent">
                          Matching Keyboard Shortcuts
                        </div>
                        {searchResults.matchedShortcuts.map((item, idx) => (
                          <div
                            key={`${item.context}-${idx}`}
                            className="px-3.5 py-2 flex items-center justify-between gap-4 border-b border-white/[0.06] last:border-b-0"
                          >
                            <div className="min-w-0">
                              <div className="text-xs text-om-text-secondary">{item.action}</div>
                              <div className="text-[10px] text-om-text-faint">{item.context}</div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {item.keys.map((keyLabel, keyIdx) => (
                                <React.Fragment key={keyIdx}>
                                  {keyIdx > 0 && (
                                    <span className="text-[10px] text-om-text-faint">/</span>
                                  )}
                                  <kbd className="px-1.5 py-0.5 rounded bg-om-control border border-white/[0.12] font-mono text-[11px] font-medium text-om-text">
                                    {keyLabel}
                                  </kbd>
                                </React.Fragment>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </>
            ) : activeCategory === 'shortcuts' ? (
              <>
                <div className="pb-2 border-b border-white/[0.08]">
                  <h4 className="font-display text-base font-semibold text-om-text">
                    Keyboard Shortcuts
                  </h4>
                  <p className="text-xs text-om-text-subtle mt-0.5">
                    Shortcuts are disabled automatically while typing inside text fields.
                  </p>
                </div>

                <div className="flex flex-col gap-3.5">
                  {SHORTCUT_GROUPS.map((group) => {
                    const items = KEYBOARD_SHORTCUTS.filter((s) => s.context === group);
                    return (
                      <div
                        key={group}
                        className="rounded-md bg-om-well border border-white/[0.08] overflow-hidden"
                      >
                        <div className="px-3.5 py-2 bg-om-sub border-b border-white/[0.08] text-[11px] font-semibold uppercase tracking-wider text-om-text-subtle">
                          {group}
                        </div>
                        {items.map((item, idx) => renderShortcutRow(item, idx))}
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <>
                <div className="pb-2 border-b border-white/[0.08]">
                  <h4 className="font-display text-base font-semibold text-om-text">
                    {activeSection.title}
                  </h4>
                  <p className="text-xs text-om-text-subtle mt-0.5">{activeSection.description}</p>
                </div>

                <div className="flex flex-col gap-3.5">
                  {activeSection.articles.map((article) => renderArticleCard(article))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-white/[0.08] bg-om-footer flex items-center justify-between gap-4 shrink-0">
          <span className="text-[11px] text-om-text-subtle">
            Tip: Press{' '}
            <kbd className="px-1.5 py-0.5 rounded bg-om-control border border-white/[0.12] font-mono text-[10px] text-om-text">
              ?
            </kbd>{' '}
            or{' '}
            <kbd className="px-1.5 py-0.5 rounded bg-om-control border border-white/[0.12] font-mono text-[10px] text-om-text">
              F1
            </kbd>{' '}
            anytime to open Help.
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-md bg-om-accent hover:bg-om-accent-bright text-om-accent-ink text-xs font-semibold transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
