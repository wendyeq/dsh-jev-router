/** Session-model commitment and independent per-main-request effort selection. */
import type { Context } from '@deepseek-ai/cordis'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createDeveloperMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmCallConfig, LlmModelInfo, LlmResolvedModelInfo, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ResolvedConfig } from './config.ts'
import { planEffortChange } from './effort.ts'
import { evaluate, JevUnavailableError } from './jev.ts'
import type { EvaluationRecord } from './jev.ts'
import { Ledger } from './ledger.ts'
import type { LedgerEntry } from './ledger.ts'
import { evaluationMessages } from './messages.ts'
import { RouterStore } from './store.ts'
import { sameRoute } from './types.ts'
import type { PersistedRouter, Selection } from './types.ts'

/** Selector-only effort value, never sent to a generation adapter. */
export const AUTO_EFFORT = ReasoningEffortId('auto/jev')

/** @param selection - user-selected route.
 * @returns whether the model selector requests automatic routing.
 */
export function automaticModel(selection: Selection): boolean {
  return selection.provider === 'auto' && selection.model === 'jev'
}

/** Concrete provider and model already committed for this session, or null when auto/jev has not chosen yet. */
function committedRoute(state: PersistedRouter): { readonly provider: string; readonly model: string } | null {
  return automaticModel(state.selection) ? state.pin : state.selection
}

function optionsSelection(options: { provider?: string | undefined; model?: string | undefined; reasoningEffort?: string | undefined } | undefined): Selection | undefined {
  if (!options?.provider || !options.model) return undefined
  return { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort }
}

/** Keeps each Session's model while selecting fresh effort for each main request. */
export class JevRouter {
  readonly store: RouterStore
  private readonly ledger: Ledger

  /** @param ctx - live Harness services.
   * @param config - validated routing configuration.
   */
  constructor(private readonly ctx: Context, private readonly config: ResolvedConfig) {
    this.store = new RouterStore(config.stateDirectory)
    this.ledger = new Ledger(config.stateDirectory, message => ctx.logger.warn(message))
  }

  /** Apply every own selection event, including repeated auto/jev selections.
   * @param session - Session whose current selection is read.
   * @param initial - creation or first assembled selection.
   * @returns router state after applying new user selections.
   */
  replaySelection(session: Session, initial: Selection): PersistedRouter {
    let state = this.store.read(session.id) ?? { version: 1 as const, selection: initial, afterSeq: -1, pin: null }
    for (const event of session.snapshotEvents()) {
      if (event.type !== 'model/selection' || !session.isOwnSeq(event.seq) || event.seq <= state.afterSeq) continue
      const wire = state.effortWire
      const keepWire = wire !== undefined && !automaticModel(event.data) && sameRoute(wire, event.data)
      state = {
        version: 1, selection: event.data, afterSeq: event.seq, pin: null,
        ...keepWire && wire ? { effortWire: wire } : {},
      }
      this.store.write(session.id, state)
    }
    return state
  }

  /** Resolve currently registered automatic models against the request's input modalities.
   * @param messages - full request input, inspected but never sent as-is to Jev.
   * @param signal - optional request cancellation during discovery.
   * @returns exact registered models, each retaining its configured task description.
   */
  async models(messages: readonly RequestMessage[], signal?: AbortSignal): Promise<(LlmResolvedModelInfo & { taskDescription: string })[]> {
    const hasImage = messages.some(message => message.content.some(block => block.type === 'image' && !block.offloaded))
    const choices: (LlmResolvedModelInfo & { taskDescription: string })[] = []
    for (const provider of this.ctx.llm.listProviders()) {
      signal?.throwIfAborted()
      let models: readonly LlmModelInfo[]
      try {
        models = await this.ctx.llm.listModels(provider.id)
      } catch (_error) {
        // A provider whose directory cannot be read offers no available models.
        signal?.throwIfAborted()
        continue
      }
      for (const candidate of this.config.candidates) {
        if (candidate.provider !== undefined && candidate.provider !== provider.id) continue
        if (!models.some(model => model.id === candidate.model)) continue
        let model: LlmResolvedModelInfo
        try {
          model = await this.ctx.llm.resolveModelInfo(provider.id, candidate.model, signal)
        } catch (_error) {
          // Unknown current capabilities make this particular model unavailable.
          signal?.throwIfAborted()
          continue
        }
        if (hasImage && !model.inputModalities?.includes('image')) continue
        choices.push({ ...model, taskDescription: candidate.description })
      }
    }
    return choices
  }

  /** Resolve a main request and commit a new model only after effort validation.
   * @param agent - owning Agent.
   * @param proposed - downstream request controls, including selector sentinels.
   * @param messages - history and accepted input for this main request.
   * @param signal - cancellation covering both evaluations and commitment.
   * @param turn - open turn, used only when a configuration update is recorded.
   * @param step - open step, used only when a configuration update is recorded.
   * @returns a concrete call. `reasoningEffort` is the request-level effort, not a later update.
   */
  async main(
    agent: Agent,
    proposed: LlmCallConfig,
    messages: readonly RequestMessage[],
    signal: AbortSignal,
    turn = 0,
    step = 0,
  ): Promise<LlmCallConfig> {
    signal.throwIfAborted()
    const state = this.inherit(agent, proposed)
    const selection = state.selection
    const autoModel = automaticModel(selection)
    const autoEffort = selection.reasoningEffort === AUTO_EFFORT || (autoModel && selection.reasoningEffort === undefined)
    const log = this.decisionLog(agent.id)
    const record = this.config.ledger ? (entry: LedgerEntry) => this.ledger.append(agent.id, entry) : undefined
    if (!autoModel && !autoEffort) {
      const { reasoningEffort: _previous, ...base } = proposed
      if (selection.reasoningEffort === undefined) {
        const resolved = await this.ctx.llm.resolveCallConfig({ ...base, provider: selection.provider, model: selection.model }, signal)
        signal.throwIfAborted()
        if (this.store.read(agent.id) === undefined) this.store.write(agent.id, state)
        return resolved
      }
      return this.finish(agent, state, turn, step, { provider: selection.provider, model: selection.model }, selection.reasoningEffort, base, signal, log)
    }
    const model = await this.selectModel(state, autoModel, messages, signal, log, record)
    const effort = await this.selectEffort(agent, state, model, messages, signal, autoEffort, log, record)
    const { reasoningEffort: _previous, ...base } = proposed
    const route = { provider: model.provider, model: model.id }
    const pinned = autoModel && state.pin === null
      ? { ...state, pin: { provider: model.provider, model: model.id, selectedAt: Date.now() } }
      : state
    if (effort === undefined) {
      const resolved = await this.ctx.llm.resolveCallConfig({ ...base, ...route }, signal)
      signal.throwIfAborted()
      this.requireSameSelection(agent.session, proposed, state.afterSeq)
      this.store.write(agent.session.id, pinned)
      log?.(`resolved provider=${resolved.provider} model=${resolved.model} effort=provider-default`)
      return resolved
    }
    return this.finish(agent, pinned, turn, step, route, effort, base, signal, log, state.afterSeq, proposed)
  }

  private async selectModel(
    state: PersistedRouter,
    autoModel: boolean,
    messages: readonly RequestMessage[],
    signal: AbortSignal,
    log: ((message: string) => void) | undefined,
    record: ((entry: LedgerEntry) => void) | undefined,
  ): Promise<LlmResolvedModelInfo> {
    if (!(autoModel && state.pin === null)) {
      const route = autoModel ? state.pin! : state.selection
      return this.ctx.llm.resolveModelInfo(route.provider, route.model, signal)
    }
    const modelMessages = evaluationMessages(messages, 'model')
    if (!modelMessages.some(message => message.role === 'user')) throw new Error('Jev routing failed: no user body')
    const available = await this.models(messages, signal)
    const choices = available.map((item, index) => ({ key: String(index), description: item.taskDescription, model: item }))
    // Model records store the concrete model in `model` and omit the criteria key.
    const report = record && (({ choice, ...rest }: EvaluationRecord) => {
      const chosen = choices.find(item => item.key === choice)?.model
      record({ ...rest, ...chosen ? { model: `${chosen.provider}/${chosen.id}` } : {} })
    })
    return (await evaluate(this.ctx.credentials, this.config, modelMessages, choices, 'model', signal, log, report, undefined)).model
  }

  private async selectEffort(
    agent: Agent,
    state: PersistedRouter,
    model: LlmResolvedModelInfo,
    messages: readonly RequestMessage[],
    signal: AbortSignal,
    autoEffort: boolean,
    log: ((message: string) => void) | undefined,
    record: ((entry: LedgerEntry) => void) | undefined,
  ): Promise<string | undefined> {
    if (!autoEffort) return state.selection.reasoningEffort
    const modelId = `${model.provider}/${model.id}`
    const descriptions = this.config.effortDescriptions[modelId] ?? this.config.effortDescriptions[model.id]
    const efforts = model.reasoning?.efforts ?? []
    // Adapters list efforts in escalation order, so the floor keeps it and everything after it.
    const floor = this.config.effortFloors[modelId] ?? this.config.effortFloors[model.id]
    const start = floor === undefined ? 0 : efforts.findIndex(item => String(item.id) === floor)
    if (start < 0) throw new Error(`Jev routing failed: effort floor ${floor} is not supported by ${modelId}`)
    const choices = efforts.slice(start).map(item => ({ key: String(item.id),
      description: descriptions?.[String(item.id)] ?? item.description ?? item.name }))
    const route = { provider: model.provider, model: model.id }
    const wire = state.effortWire
    const previous = agent.session.requestHeader()?.config
    const held = (wire && sameRoute(wire, route) ? wire.effectiveEffort : undefined)
      ?? (previous && sameRoute(previous, route) ? previous.reasoningEffort : undefined)
    const offered = (key: string | undefined): key is string => key !== undefined && choices.some(choice => choice.key === key)
    try {
      const report = record && ((entry: EvaluationRecord) => record({ ...entry, model: modelId }))
      return (await evaluate(this.ctx.credentials, this.config, evaluationMessages(messages, 'effort'), choices, 'effort', signal, log, report, offered(held) ? held : undefined)).key
    } catch (error) {
      if (!(error instanceof JevUnavailableError)) throw error
      signal.throwIfAborted()
      const adapterDefault = model.reasoning?.defaultEffort
      // A default below the floor is raised to the floor; an unsupported default still fails.
      const belowFloor = adapterDefault !== undefined && efforts.slice(0, start).some(item => item.id === adapterDefault)
      let fallback: string
      let source: 'previous' | 'adapter-default' | 'floor'
      if (offered(held)) {
        fallback = held
        source = 'previous'
      } else if (offered(adapterDefault)) {
        fallback = adapterDefault
        source = 'adapter-default'
      } else if (belowFloor) {
        fallback = choices[0]!.key
        source = 'floor'
      } else {
        throw error
      }
      log?.(`effort unavailable reason=${error.reason} fallback=${fallback} source=${source}`)
      record?.({ question: 'effort', outcome: 'fallback', model: modelId, choice: fallback, source, reason: error.reason })
      return fallback
    }
  }

  /** Replay, then fail if a selection event landed while this request was being resolved. */
  private requireSameSelection(session: Session, proposed: Selection, afterSeq: number): void {
    if (this.replaySelection(session, proposed).afterSeq !== afterSeq) throw new Error('Jev routing failed: selection changed during evaluation')
  }

  /** Resolve the request-level effort, then record a configuration update when the effort changed.
   * @param agent - owning Agent.
   * @param state - router state, including a pin committed in this call.
   * @param turn - open turn for a recorded update.
   * @param step - open step for a recorded update.
   * @param route - concrete model.
   * @param effort - effort chosen for this request.
   * @param base - downstream controls other than reasoning effort.
   * @param signal - cancellation covering resolution and commitment.
   * @param log - optional diagnostic writer.
   * @param afterSeq - selection cursor captured before evaluation; defaults to `state`.
   * @param proposed - selection used to detect a concurrent change.
   * @returns the concrete call. Its effort is the request-level value.
   */
  private async finish(
    agent: Agent,
    state: PersistedRouter,
    turn: number,
    step: number,
    route: { provider: string; model: string },
    effort: string,
    base: Omit<LlmCallConfig, 'reasoningEffort'>,
    signal: AbortSignal,
    log: ((message: string) => void) | undefined,
    afterSeq = state.afterSeq,
    proposed: Selection = state.selection,
  ): Promise<LlmCallConfig> {
    const plan = planEffortChange(state.effortWire, route, effort, agent.session.deriveMessages())
    const resolved = await this.ctx.llm.resolveCallConfig({
      ...base, ...route, reasoningEffort: ReasoningEffortId(plan.requestEffort),
    }, signal)
    signal.throwIfAborted()
    this.requireSameSelection(agent.session, proposed, afterSeq)
    if (plan.append) {
      agent.session.append('developer/message', {
        turn,
        step,
        message: createDeveloperMessage({
          source: { kind: 'jev-configuration-update' },
          content: [{ type: 'configuration-update', effort: plan.effectiveEffort, provider: route.provider, model: route.model }],
        }),
      }, { surfaceOp: 'append' })
    }
    this.store.write(agent.session.id, { ...state, effortWire: plan.wire })
    log?.(`resolved provider=${resolved.provider} model=${resolved.model} effort=${plan.effectiveEffort}`)
    return resolved
  }

  /** Diagnostic line for one Session. Undefined when neither sink is enabled. */
  private decisionLog(sessionId: string): ((message: string) => void) | undefined {
    if (!this.config.logDecisions && !this.config.diagnosticLogFile) return undefined
    return message => {
      if (this.config.logDecisions) this.ctx.logger.info(`dsh-jev-router session=${sessionId} ${message}`)
      if (!this.config.diagnosticLogFile) return
      try {
        mkdirSync(dirname(this.config.diagnosticLogFile), { recursive: true, mode: 0o700 })
        appendFileSync(this.config.diagnosticLogFile,
          JSON.stringify({ time: new Date().toISOString(), sessionId, message }) + '\n', { mode: 0o600 })
      } catch (_error) {
        // A diagnostic write must never turn a model request into a failed request.
        this.ctx.logger.warn('dsh-jev-router: diagnostic log write failed')
      }
    }
  }

  private inherit(agent: Agent, proposed: Selection): PersistedRouter {
    const state = this.replaySelection(agent.session, proposed)
    const parentId = agent.session.header.parentSession
    if (parentId === undefined) return state
    // A child that already has its own concrete selection does not inherit. Automatic routing still does.
    const chosenHere = !automaticModel(state.selection) && (state.afterSeq >= 0 || this.store.read(agent.id) !== undefined)
    if (chosenHere) return state
    const parent = this.ctx.agents.get(parentId)
    const parentSession = this.ctx.sessions.get(parentId)
    const parentInitial = optionsSelection(parent?.options) ?? parentSession?.requestHeader()?.config
    const parentState = parentSession && parentInitial ? this.replaySelection(parentSession, parentInitial) : this.store.read(parentId)
    if (!parentState) throw new Error('Jev routing failed: parent has no session model')
    const parentRoute = committedRoute(parentState)
    const previous = parentSession?.requestHeader()?.config
    const explicit = !agent.session.header.isSeeded && !automaticModel(proposed) && proposed.provider && proposed.model
      && (proposed.provider !== previous?.provider || proposed.model !== previous.model)
    if (!parentRoute && !explicit) throw new Error('Jev routing failed: parent has no session model')
    const route = explicit ? proposed : parentRoute!
    const effort = parentState.selection.reasoningEffort
      ?? (automaticModel(parentState.selection) ? AUTO_EFFORT : undefined)
    const inherited: PersistedRouter = { ...state, selection: { provider: route.provider, model: route.model,
      ...effort === undefined ? {} : { reasoningEffort: effort } } }
    this.store.write(agent.id, inherited)
    return inherited
  }

  /** Resolve a purpose-tagged call without evaluating or committing a model.
   * @param options - title or compaction request.
   * @returns the selected concrete model with its own default effort.
   */
  async auxiliary(options: GenerateOptions): Promise<GenerateOptions> {
    if (options.sessionId === undefined) {
      if (automaticModel(options) || options.reasoningEffort === AUTO_EFFORT) throw new Error('Jev routing failed: no session model')
      return options
    }
    const session = this.ctx.sessions.get(options.sessionId)
    const agent = this.ctx.agents.get(options.sessionId)
    const initial = optionsSelection(agent?.options) ?? options
    const state = session ? this.replaySelection(session, initial) : this.store.read(options.sessionId)
    if (!state) throw new Error('Jev routing failed: no session model')
    const route = committedRoute(state)
    if (!route) throw new Error('Jev routing failed: no session model')
    const { reasoningEffort: _previous, ...base } = options
    const resolved = await this.ctx.llm.resolveCallConfig({ ...base, provider: route.provider, model: route.model }, options.signal)
    options.signal?.throwIfAborted()
    return { ...base, ...resolved }
  }
}
