import { Logger, ModuleDefinition, ModuleEntryPoint, Skill } from 'botpress/sdk'
import { ValidationError } from 'errors'
import fse from 'fs-extra'
import { inject, injectable, tagged } from 'inversify'
import joi from 'joi'
import _ from 'lodash'

import { AppLifecycle, AppLifecycleEvents } from 'lifecycle'

import { createForModule } from './api' // TODO
import ModuleResolver from './modules/resolver'
import { GhostService } from './services'
import ConfigReader from './services/module/config-reader'
import { TYPES } from './types'

const MODULE_SCHEMA = joi.object().keys({
  onServerStarted: joi.func().required(),
  onServerReady: joi.func().required(),
  onBotMount: joi.func().optional(),
  onBotUnmount: joi.func().optional(),
  skills: joi.array().optional(),
  definition: joi.object().keys({
    name: joi.string().required(),
    fullName: joi.string().optional(),
    plugins: joi
      .array()
      .optional()
      .default([]),
    noInterface: joi
      .boolean()
      .optional()
      .default(false),
    moduleView: joi
      .object()
      .optional()
      .keys({
        stretched: joi.boolean().default(false)
      }),
    menuIcon: joi.string().optional(),
    menuText: joi.string().optional(),
    homepage: joi.string().optional()
  })
})

@injectable()
export class ModuleLoader {
  private entryPoints = new Map<string, ModuleEntryPoint>()
  private _configReader?: ConfigReader

  constructor(
    @inject(TYPES.Logger)
    @tagged('name', 'ModuleLoader')
    private logger: Logger,
    @inject(TYPES.GhostService) private ghost: GhostService,
    @inject(TYPES.AppLifecycle) private lifecycle: AppLifecycle
  ) {}

  public get configReader() {
    if (this._configReader) {
      return this._configReader
    }

    throw new Error('Configuration reader is not initialized (you need to load modules first)')
  }

  public set configReader(value: ConfigReader) {
    if (this._configReader) {
      throw new Error('Modules have already been loaded')
    }

    this._configReader = value
  }

  public static processModuleEntryPoint(module: ModuleEntryPoint, name: string): ModuleEntryPoint {
    const ret = MODULE_SCHEMA.validate(module, { abortEarly: false })

    if (ret.error) {
      const message = (name.length ? `Module "${name}" has` : '') + 'invalid configuration'
      throw new ValidationError(ret.error, message)
    }

    const definition: Partial<ModuleDefinition> = {
      fullName: module.definition.name,
      menuIcon: 'view_module',
      menuText: module.definition.name,
      moduleView: { stretched: false },
      noInterface: false,
      plugins: []
    }

    return _.merge({ definition }, ret.value)
  }

  // FIXME: Load modules for bots using onBotMount instead of init
  public async loadModules(modules: ModuleEntryPoint[]) {
    this.configReader = new ConfigReader(this.logger, modules, this.ghost)
    await this.configReader.initialize()
    const initedModules = {}

    for (const module of modules) {
      const name = _.get(module, 'definition.name', '').toLowerCase()
      try {
        ModuleLoader.processModuleEntryPoint(module, name)
        const api = await createForModule(name)
        await (module.onServerStarted && module.onServerStarted(api))
        initedModules[name] = true
        this.entryPoints.set(name, module)
      } catch (err) {
        this.logger.attachError(err).error(`Error in module "${name}" onServerStarted`)
      }
    }

    this.callModulesOnReady(modules, initedModules) // Floating promise here is on purpose, we are doing this in background
    return Object.keys(initedModules)
  }

  public async unloadModulesForBot(botId: string) {
    const modules = this.getLoadedModules()
    for (const module of modules) {
      const entryPoint = this.getModule(module.name)
      const api = await createForModule(module.name)
      await (entryPoint.onBotUnmount && entryPoint.onBotUnmount(api, botId))
    }
  }

  private async callModulesOnReady(modules: ModuleEntryPoint[], initedModules: {}): Promise<void> {
    await this.lifecycle.waitFor(AppLifecycleEvents.HTTP_SERVER_READY)

    // Once all the modules have been loaded, we tell them it's ready
    // TODO We probably want to wait until Botpress is done loading the other services etc
    for (const module of modules) {
      const name = module.definition.name.toLowerCase()
      if (!initedModules[name]) {
        this.logger.warn(`Module "${name}" skipped`)
        continue
      }

      try {
        const api = await createForModule(name)
        await (module.onServerReady && module.onServerReady(api))
        this.loadModulesActions(name)
        this.loadModuleHooks(name)
        this.loadModuleAssets(name)
      } catch (err) {
        this.logger.warn(`Error in module "${name}" 'onServerReady'. Module will still be loaded. Err: ${err.message}`)
      }
    }
  }

  public async loadModulesForBot(botId: string) {
    const modules = this.getLoadedModules()
    for (const module of modules) {
      const entryPoint = this.getModule(module.name)
      const api = await createForModule(module.name)
      await (entryPoint.onBotMount && entryPoint.onBotMount(api, botId))
    }
  }

  private async loadModulesActions(name: string) {
    const resolver = new ModuleResolver(this.logger)
    const modulePath = await resolver.resolve('MODULES_ROOT/' + name)
    const moduleActionsDir = `${modulePath}/dist/actions`

    if (fse.pathExistsSync(moduleActionsDir)) {
      const globalActionsDir = `${process.PROJECT_LOCATION}/data/global/actions/${name}`
      fse.mkdirpSync(globalActionsDir)
      fse.copySync(moduleActionsDir, globalActionsDir)
    }
  }

  private async loadModuleAssets(name: string) {
    const resolver = new ModuleResolver(this.logger)
    const modulePath = await resolver.resolve('MODULES_ROOT/' + name)
    const modulesAssetsPath = `${modulePath}/assets/`

    if (fse.pathExistsSync(modulesAssetsPath)) {
      const assetsPath = `${process.PROJECT_LOCATION}/assets/modules/${name}`
      fse.mkdirpSync(assetsPath)
      fse.copySync(modulesAssetsPath, assetsPath)
    }
  }

  private async loadModuleHooks(name: string) {
    const resolver = new ModuleResolver(this.logger)
    const modulePath = await resolver.resolve('MODULES_ROOT/' + name)

    const moduleHooks = `${modulePath}/dist/hooks/`
    if (fse.pathExistsSync(moduleHooks)) {
      const hookTypes = await fse.readdir(moduleHooks)

      for (const hookType of hookTypes) {
        const globalHooksDir = `${process.PROJECT_LOCATION}/data/global/hooks/${hookType}/${name}`
        fse.mkdirpSync(globalHooksDir)
        fse.copySync(`${moduleHooks}/${hookType}`, globalHooksDir)
      }
    }
  }

  public getLoadedModules(): ModuleDefinition[] {
    const definitions = Array.from(this.entryPoints.values()).map(x => x.definition)
    return definitions
  }

  public async getFlowGenerator(moduleName, skillId) {
    const module = this.getModule(moduleName)
    const skill = _.find(module.skills, x => x.id === skillId)

    return skill && skill.flowGenerator
  }

  public async getAllSkills() {
    const allSkills: Skill[] = []
    const modules = this.getLoadedModules()

    for (const module of modules) {
      const entryPoint = this.getModule(module.name)
      const skills = _.map(entryPoint.skills, e => _.pick(e, 'id', 'name'))

      _.forEach(skills, skill =>
        allSkills.push({
          id: skill.id,
          name: skill.name,
          moduleName: module.name
        })
      )
    }

    return allSkills
  }

  private getModule(module: string) {
    module = module.toLowerCase()
    if (!this.entryPoints.has(module)) {
      throw new Error(`Module '${module}' not registered`)
    }

    return this.entryPoints.get(module)!
  }
}
