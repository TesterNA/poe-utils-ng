/* Map Strategy — an atlas tree, the map device that goes with it, and a note.

   The atlas tool plans a tree. This one plans a *run*: the tree is only half of
   what you set up before mapping, and the scarabs are the half that changes
   week to week. Keeping them here rather than on the atlas panel means a tree
   can be shared, saved and swapped without dragging a scarab set behind it, and
   that one tree can back several strategies.

   Everything the game would refuse is checked as you build: five slots in the
   device, each item's own limit, and Unwavering Vision — which shuts the
   fragment slots altogether, so a tree that takes it cannot use any of this. */
import { afterNextRender, Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { PoeCard } from '../../shared/poe-card';
import { ToolPage } from '../../shared/tool-page';
import { loadBuilds, type SavedBuild } from '../atlas/atlas-builds';
import { peekPlan, ShareCodeError } from '../atlas/share-code';
import { loadTree } from '../atlas/tree-loader';
import type { Tree } from '../atlas/tree-types';
import { DEFAULT_TREE_VERSION, findTreeVersion } from '../atlas/tree-versions';
import { decodeStrategy, encodeStrategy, peekStrategy } from './strategy-code';
import {
  iconUrl,
  loadItems,
  MAP_DEVICE_SLOTS,
  unavailableReason,
  type ItemCatalogue,
  type ItemGroup,
  type StrategyItem,
} from './strategy-items';
import {
  addPick,
  atLimit,
  dropPick,
  emptyStrategy,
  gameVersionOf,
  removePick,
  slotsUsed,
  summariseTree,
  validate,
  type Pick,
  type Strategy as StrategyPlan,
  type StrategyIssue,
  type TreeSummary,
} from './strategy-plan';
import {
  exportAll,
  importAll,
  loadLibrary,
  loadState,
  storeLibrary,
  storeState,
  upsertStrategy,
  type SavedStrategy,
} from './strategy-store';

/** A filled slot in the map device, or one of the empty ones after it. */
interface SlotView {
  item: StrategyItem | null;
  /** copies of `item`; only the first of a stack carries the row */
  count: number;
  problem: boolean;
}

type Kind = 'all' | 'scarab' | 'allflame';

@Component({
  selector: 'poe-strategy',
  imports: [PoeCard, ToolPage, RouterLink],
  templateUrl: './strategy.html',
})
export class Strategy {
  private readonly router = inject(Router);
  private readonly activatedRoute = inject(ActivatedRoute);

  readonly slotLimit = MAP_DEVICE_SLOTS;

  readonly loading = signal('Loading the scarab list...');
  readonly catalogue = signal<ItemCatalogue | null>(null);

  readonly treeVersion = signal(DEFAULT_TREE_VERSION);
  readonly treeCode = signal('');
  readonly picks = signal<Pick[]>([]);
  readonly notes = signal('');

  /** What the attached tree turned out to be, once it has been read. */
  readonly treeSummary = signal<TreeSummary | null>(null);
  readonly treeMessage = signal('');
  readonly atlasBuilds = signal<SavedBuild[]>([]);

  readonly query = signal('');
  readonly kind = signal<Kind>('all');
  readonly group = signal('');

  readonly importText = signal('');
  readonly shareMessage = signal('');
  readonly name = signal('');
  readonly library = signal<SavedStrategy[]>([]);

  readonly gameVersion = computed(() => gameVersionOf(this.plan()));
  readonly used = computed(() => slotsUsed(this.picks()));

  private readonly plan = computed<StrategyPlan>(() => ({
    treeVersion: this.treeVersion(),
    treeCode: this.treeCode(),
    picks: this.picks(),
    notes: this.notes(),
  }));

  readonly shareCode = computed(() => encodeStrategy(this.plan()));

  readonly issues = computed<StrategyIssue[]>(() => {
    const catalogue = this.catalogue();
    if (!catalogue) return [];
    return validate({
      picks: this.picks(),
      catalogue,
      gameVersion: this.gameVersion(),
      blockers: this.treeSummary()?.blockers ?? [],
    });
  });

  readonly errors = computed(() => this.issues().filter((issue) => issue.level === 'error'));

  /** Item codes an issue named, so the device row and the picker can both flag them. */
  private readonly flagged = computed(
    () => new Set(this.issues().flatMap((issue) => (issue.itemCode ? [issue.itemCode] : []))),
  );

  /**
   * The device drawn as it looks: one row per copy, then the empty slots. Over
   * the limit there are simply more rows than the device has, which reads
   * better than hiding the ones that do not fit.
   */
  readonly slots = computed<SlotView[]>(() => {
    const catalogue = this.catalogue();
    const flagged = this.flagged();
    const rows: SlotView[] = [];
    for (const pick of this.picks()) {
      const item = catalogue?.byCode.get(pick.code) ?? null;
      rows.push({ item, count: pick.count, problem: !item || flagged.has(pick.code) });
    }
    for (let i = this.used(); i < MAP_DEVICE_SLOTS; i++) {
      rows.push({ item: null, count: 0, problem: false });
    }
    return rows;
  });

  /** Every mechanic in the catalogue, for the group dropdown. */
  readonly groupNames = computed(() => (this.catalogue()?.groups ?? []).map((g) => g.name));

  /** The picker: groups and items left after the kind, group and text filters. */
  readonly visible = computed<ItemGroup[]>(() => {
    const catalogue = this.catalogue();
    if (!catalogue) return [];
    const kind = this.kind();
    const group = this.group();
    const q = this.query().trim().toLowerCase();
    const out: ItemGroup[] = [];
    for (const candidate of catalogue.groups) {
      if (kind !== 'all' && candidate.type !== kind) continue;
      if (group && candidate.name !== group) continue;
      const items = q
        ? candidate.items.filter(
            (item) =>
              item.name.toLowerCase().includes(q) ||
              item.stats.some((stat) => stat.toLowerCase().includes(q)),
          )
        : candidate.items;
      if (items.length) out.push({ ...candidate, items });
    }
    return out;
  });

  readonly currentSavedId = computed(() => {
    const code = this.shareCode();
    return this.library().find((entry) => entry.code === code)?.id ?? null;
  });

  /** Cached per tree version — reading a code needs the whole 1.5 MB dataset. */
  private readonly trees = new Map<number, Tree>();
  /** Bumped on every tree change so a slow load cannot land on top of a newer one. */
  private treeToken = 0;
  private started = false;

  constructor() {
    afterNextRender(() => void this.init());
    // The code is the state, so persisting it is the whole of persistence.
    // Skipped until startup has applied whatever it is going to apply, or the
    // empty strategy this begins as would overwrite the stored one.
    effect(() => {
      const code = this.shareCode();
      if (this.started) storeState(code);
    });
  }

  private async init(): Promise<void> {
    this.atlasBuilds.set(loadBuilds());
    this.library.set(loadLibrary());
    try {
      this.catalogue.set(await loadItems());
      this.loading.set('');
    } catch (err) {
      this.loading.set(err instanceof Error ? err.message : String(err));
      return;
    }

    const inbound = this.activatedRoute.snapshot.queryParamMap.get('s');
    const stored = loadState();
    if (inbound) {
      this.applyCode(inbound, 'link');
      // Drop the parameter: a later refresh should keep your edits rather than
      // re-importing the original strategy on top of them.
      void this.router.navigate([], {
        relativeTo: this.activatedRoute,
        queryParams: {},
        replaceUrl: true,
      });
    } else if (stored) {
      this.applyCode(stored, 'stored');
    }
    this.started = true;
    void this.refreshTree();
  }

  // ------------------------------------------------------------------ tree ---

  onTreeInput(event: Event): void {
    this.importText.set('');
    this.treeMessage.set('');
    this.attachTree((event.target as HTMLInputElement).value);
  }

  attachTree(code: string): void {
    const trimmed = code.trim();
    if (!trimmed) {
      this.detachTree();
      return;
    }
    try {
      const { treeVersion } = peekPlan(trimmed);
      if (!findTreeVersion(treeVersion)) {
        this.treeMessage.set(
          `That tree is version ${treeVersion}, which this build does not have.`,
        );
        return;
      }
      this.treeVersion.set(treeVersion);
      this.treeCode.set(trimmed);
      this.treeMessage.set('');
      void this.refreshTree();
    } catch (err) {
      this.treeMessage.set(err instanceof ShareCodeError ? err.message : 'Could not read that code.');
    }
  }

  detachTree(): void {
    this.treeCode.set('');
    this.treeSummary.set(null);
    this.treeMessage.set('');
    this.treeToken++;
  }

  onBuildPicked(event: Event): void {
    const id = (event.target as HTMLSelectElement).value;
    const build = this.atlasBuilds().find((entry) => entry.id === id);
    if (build) this.attachTree(build.code);
  }

  /**
   * Which saved build the select should be showing — worked out from the code
   * that is attached rather than remembered from the click, so it stays right
   * when the tree arrives from a link, a paste or an imported strategy. Empty
   * when the attached tree is not one of the saved ones, which is the honest
   * answer: the library does not have it.
   */
  readonly attachedBuildId = computed(() => {
    const code = this.treeCode();
    return code ? (this.atlasBuilds().find((entry) => entry.code === code)?.id ?? '') : '';
  });

  /** Reads the attached code against its dataset, fetching that dataset once. */
  private async refreshTree(): Promise<void> {
    const token = ++this.treeToken;
    const code = this.treeCode();
    if (!code) {
      this.treeSummary.set(null);
      return;
    }
    const version = this.treeVersion();
    try {
      let tree = this.trees.get(version);
      if (!tree) {
        tree = await loadTree(version);
        this.trees.set(version, tree);
      }
      if (token !== this.treeToken) return;
      this.treeSummary.set(summariseTree(tree, code));
      this.treeMessage.set('');
    } catch (err) {
      if (token !== this.treeToken) return;
      this.treeSummary.set(null);
      this.treeMessage.set(
        err instanceof ShareCodeError ? err.message : 'Could not read the attached tree.',
      );
    }
  }

  /** Link into the atlas tool with this tree loaded. */
  readonly atlasParams = computed(() => ({ c: this.treeCode() }));

  // ----------------------------------------------------------------- picks ---

  add(item: StrategyItem): void {
    if (this.disabledReason(item)) return;
    this.picks.update((picks) => addPick(picks, item.code));
  }

  remove(code: number): void {
    this.picks.update((picks) => removePick(picks, code));
  }

  drop(code: number): void {
    this.picks.update((picks) => dropPick(picks, code));
  }

  clearPicks(): void {
    this.picks.set([]);
  }

  /** Why the picker will not add another of this, or '' when it will. */
  disabledReason(item: StrategyItem): string {
    const gone = this.gameVersion() ? unavailableReason(item, this.gameVersion()) : null;
    if (gone) return gone;
    if (this.treeSummary()?.blockers.length) return 'blocked by the tree';
    if (atLimit(this.picks(), item)) return `limit ${item.limit}`;
    if (this.used() >= MAP_DEVICE_SLOTS) return 'device full';
    return '';
  }

  countOf(item: StrategyItem): number {
    return this.picks().find((pick) => pick.code === item.code)?.count ?? 0;
  }

  /** Empty `icon` means poedb's CDN would not give us the art; the row keeps the gap. */
  icon(item: StrategyItem): string {
    return iconUrl(item);
  }

  // ---------------------------------------------------------------- filters --

  setKind(kind: Kind): void {
    this.kind.set(kind);
    // The group list is per kind, so a group from the other kind would filter
    // everything away and look like an empty catalogue.
    const groups = this.catalogue()?.groups ?? [];
    const current = groups.find((g) => g.name === this.group());
    if (current && kind !== 'all' && current.type !== kind) this.group.set('');
  }

  onGroupChange(event: Event): void {
    this.group.set((event.target as HTMLSelectElement).value);
  }

  onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  onNotes(event: Event): void {
    this.notes.set((event.target as HTMLTextAreaElement).value);
  }

  // ----------------------------------------------------------------- share ---

  shareLink(): string {
    return `${location.origin}${location.pathname}?s=${this.shareCode()}`;
  }

  async copyCode(): Promise<void> {
    await this.copyText(this.shareCode(), 'Code copied.');
  }

  async copyLink(): Promise<void> {
    await this.copyText(this.shareLink(), 'Link copied.');
  }

  private async copyText(text: string, done: string): Promise<void> {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.shareMessage.set(done);
    } catch {
      this.shareMessage.set('Clipboard blocked — select the text and copy it manually.');
    }
  }

  onImportInput(event: Event): void {
    this.importText.set((event.target as HTMLInputElement).value);
    this.shareMessage.set('');
  }

  importCode(): void {
    const text = this.importText().trim();
    if (!text) return;
    // A tab means this is an exported library rather than a single code.
    if (text.includes('\t')) {
      this.importLibrary();
      return;
    }
    if (this.applyCode(text, 'paste')) this.importText.set('');
  }

  /**
   * Applies a strategy code. An atlas code is accepted here too — pasting the
   * tree you just planned into the only paste box on the page is the obvious
   * thing to try, and refusing it would be pedantry.
   */
  private applyCode(code: string, from: 'link' | 'stored' | 'paste'): boolean {
    const trimmed = code.trim();
    if (trimmed.startsWith('AT')) {
      this.attachTree(trimmed);
      if (from === 'paste') this.shareMessage.set('Attached that atlas tree.');
      return true;
    }
    try {
      const { treeVersion } = peekStrategy(trimmed);
      if (!findTreeVersion(treeVersion)) {
        this.shareMessage.set(
          `This strategy is for atlas tree version ${treeVersion}, which this build does not have.`,
        );
        return false;
      }
      const strategy = decodeStrategy(trimmed);
      this.treeVersion.set(strategy.treeVersion);
      this.treeCode.set(strategy.treeCode);
      this.picks.set(strategy.picks);
      this.notes.set(strategy.notes);
      this.treeMessage.set('');
      if (from !== 'stored') {
        this.shareMessage.set(
          `Imported ${strategy.picks.length ? `${slotsUsed(strategy.picks)} items` : 'a strategy'}` +
            `${strategy.treeCode ? ' and a tree' : ''}.`,
        );
      }
      void this.refreshTree();
      return true;
    } catch (err) {
      // Stored state that no longer parses is not worth complaining about; it
      // just means the format moved on and this session starts fresh.
      if (from !== 'stored') {
        this.shareMessage.set(
          err instanceof ShareCodeError ? err.message : 'Could not read that code.',
        );
      }
      return false;
    }
  }

  reset(): void {
    const fresh = emptyStrategy(DEFAULT_TREE_VERSION);
    this.treeVersion.set(fresh.treeVersion);
    this.treeCode.set('');
    this.picks.set([]);
    this.notes.set('');
    this.treeSummary.set(null);
    this.treeMessage.set('');
    this.shareMessage.set('');
    this.treeToken++;
  }

  // --------------------------------------------------------------- library ---

  onNameInput(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
  }

  save(): void {
    const name = this.name().trim();
    if (!name) return;
    const next = upsertStrategy(this.library(), {
      name,
      code: this.shareCode(),
      slots: this.used(),
      points: this.treeSummary()?.points ?? 0,
    });
    if (!storeLibrary(next)) {
      this.shareMessage.set('Could not save — browser storage is full or disabled.');
      return;
    }
    this.library.set(next);
    this.name.set('');
    this.shareMessage.set(`Saved "${name}".`);
  }

  load(entry: SavedStrategy): void {
    this.applyCode(entry.code, 'paste');
  }

  delete(entry: SavedStrategy): void {
    const next = this.library().filter((saved) => saved.id !== entry.id);
    if (!storeLibrary(next)) {
      this.shareMessage.set('Could not update storage.');
      return;
    }
    this.library.set(next);
  }

  async exportLibrary(): Promise<void> {
    const text = exportAll(this.library());
    if (!text) return;
    await this.copyText(text, `Copied ${this.library().length} strategies.`);
  }

  private importLibrary(): void {
    const merged = importAll(this.importText().trim(), this.library());
    if (!storeLibrary(merged)) {
      this.shareMessage.set('Could not save — browser storage is full or disabled.');
      return;
    }
    this.library.set(merged);
    this.importText.set('');
    this.shareMessage.set(`Library now has ${merged.length} strategies.`);
  }
}
