import { existsSync } from 'fs'
import { resolve, join } from 'path'
import { execa } from 'execa'
import fse from 'fs-extra'
import archiver from 'archiver'
import { NodeSSH } from 'node-ssh'
import ora from 'ora'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { renderConfigTemplate } from './utils/template'

/** 部署配置接口 - 定义所有部署相关的配置选项 */
export interface DeployConfig {
  /** 环境名称 - 必需，用于标识不同的部署环境，如 'dev', 'prod', 'staging' 等 */
  name: string
  /** 构建命令 - 可选，用于在部署前构建项目，如 'npm run build' */
  buildCommand?: string
  /** 构建输出目录 - 必需，指定构建后的文件目录，如 'dist' 或 '.output' */
  buildDir: string
  /**
   * 额外部署文件列表
   *  - 可选，独立于构建目录单独上传到服务器版本目录的文件
   * 通常是项目根目录下的文件，如 ['package.json', '.env']
   */
  files?: string[]
  /** 服务器连接配置 - 必需，包含所有服务器连接信息 */
  server: {
    /** 服务器地址 - 必需，IP地址或域名，如 '192.168.1.100' */
    host: string
    /** SSH端口 - 可选，默认22，服务器SSH连接端口 */
    port?: number
    /** 用户名 - 必需，SSH登录用户名，如 'root' */
    username: string
    /** 私钥内容 - 可选，SSH私钥，第一优先级 */
    privateKey?: string
    /** 私钥路径 - 可选，SSH私钥文件路径，第二优先级 */
    privateKeyPath?: string
    /** 密码 - 可选，SSH登录密码，第三优先级 */
    password?: string
    /** 部署路径 - 必需，服务器上的部署目录，如 '/var/www/app' */
    deployPath: string
  }
  /** PM2配置 - 可选，进程管理器配置 */
  pm2?: {
    /** 应用名称 - 必需，PM2中的应用名称，用于重启应用 */
    appName: string
    /** 是否重启 - 可选，默认true，部署后是否自动重启PM2应用 */
    restart?: boolean
    /** PM2环境 - 可选，指定PM2启动时的环境，如 'production'、'staging' 等，对应 --env 参数 */
    env?: string
  }
  /** 排除文件列表 - 可选，打包时要排除的文件/目录模式，如 ['node_modules/**'] */
  excludeFiles?: string[]
  /** 部署前命令 - 可选，部署前在本地执行的命令数组，如 ['npm test'] */
  beforeDeploy?: string[]
  /** 部署后命令 - 可选，部署后在服务器 deployPath 根目录执行的命令数组，如 ['npm install --production'] */
  afterDeploy?: string[]
}

/** 多环境配置接口 */
export interface MultiEnvConfig {
  /** 应用配置数组 - 每个元素都是一个完整的部署配置 */
  apps: DeployConfig[]
}

/** 环境配置解析结果接口 */
interface EnvConfigResult {
  /** 指定的环境配置 - 如果envName为空则为null */
  targetConfig: DeployConfig | null
  /** 所有环境配置列表 */
  allConfigs: DeployConfig[]
}
/** 部署命令选项接口 - deploy命令的参数选项 */
interface DeployOptions {
  /** 配置文件路径 - 必需，pcli-cd.config.js文件的路径 */
  config: string
  /** 版本号 - 可选，命令行指定的版本号 */
  version?: string
  /** 环境名称 - 可选，指定部署环境，如 dev、prod、staging 等，不指定则交互式选择 */
  name?: string
}
/** 列表命令选项接口 - list命令的参数选项 */
interface ListOptions {
  /** 配置文件路径 - 必需，用于获取服务器连接信息 */
  config: string
  /** 环境名称 - 可选，指定查看的环境，不指定则交互式选择 */
  name?: string
}
/** 回滚命令选项接口 - rollback命令的参数选项 */
interface RollbackOptions {
  /** 配置文件路径 - 必需，用于获取服务器连接信息 */
  config: string
  /** 目标版本号 - 可选，要回滚到的版本，不指定则交互式选择 */
  version?: string
  /** 环境名称 - 可选，指定回滚的环境，不指定则交互式选择 */
  name?: string
}

/** 部署命令 */
export async function deployCommand(options: DeployOptions): Promise<void> {
  const configPath = resolve(process.cwd(), options.config)

  // 读取配置文件并解析环境配置
  const configResult = await resolveEnvConfig(configPath, options.name)

  // 确定环境配置（指定或交互式选择）
  let config: DeployConfig

  if (configResult.targetConfig) {
    // 如果已经指定了环境，直接使用
    config = configResult.targetConfig
  } else {
    // 如果没有指定环境，交互式选择
    const selected = await selectEnvironmentFromConfigs(configResult.allConfigs)
    config = selected.targetConfig
  }

  // 显示当前使用的环境
  console.log(chalk.blue(`🚀 部署环境: ${chalk.bold(config.name)}`))
  console.log(chalk.gray(`📍 部署路径: ${config.server.deployPath}`))

  // 询问版本号
  let version = options.version
  if (!version) {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'version',
        message: '请输入版本号 (例如: v1.0.0):',
        default: `v${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}`,
        validate: (input) => input.trim() !== '' || '版本号不能为空',
      },
    ])
    version = answers.version
  }

  await deploy(config, version!)
}

/** 部署 */
async function deploy(config: DeployConfig, version: string): Promise<void> {
  const spinner = ora()
  const tempDir = join(process.cwd(), '.deploy-temp')
  const zipPath = join(tempDir, 'build.zip')
  const buildDirName = config.buildDir.split('/').pop() || 'build'

  try {
    // 1. 清理临时目录
    await fse.remove(tempDir)
    await fse.ensureDir(tempDir)

    // 2. 执行构建前命令
    if (config.beforeDeploy) {
      spinner.start('执行构建前命令...')
      for (const cmd of config.beforeDeploy) {
        await execa('bash', ['-c', cmd], { stdio: 'inherit' })
      }
      spinner.succeed('构建前命令执行完成')
    }

    // 3. 执行构建
    if (config.buildCommand) {
      spinner.start('正在构建项目...')
      await execa('bash', ['-c', config.buildCommand], { stdio: 'inherit' })
      spinner.succeed('项目构建完成')
    }

    // 4. 检查构建目录
    const buildPath = resolve(process.cwd(), config.buildDir)
    if (!existsSync(buildPath)) {
      throw new Error(`构建目录不存在: ${buildPath}`)
    }

    // 5. 压缩文件（额外文件一并打入压缩包根部）
    spinner.start('正在压缩文件...')
    const extraFilesForZip: { localPath: string; name: string }[] = []
    if (config.files && config.files.length > 0) {
      for (const file of config.files) {
        const localFilePath = resolve(process.cwd(), file)
        if (existsSync(localFilePath)) {
          extraFilesForZip.push({ localPath: localFilePath, name: file })
        } else {
          console.warn(chalk.yellow(`⚠️ 额外文件不存在，已跳过: ${file}`))
        }
      }
    }
    await createZip(buildPath, zipPath, config.excludeFiles, extraFilesForZip)
    spinner.succeed('文件压缩完成')

    // 6. 上传到服务器
    spinner.start('正在连接服务器...')
    const ssh = await createSSHConnection(config.server)
    spinner.succeed('服务器连接成功')

    // 6.1. 清理残留的临时链接
    await cleanTempLinks(ssh, config.server.deployPath, buildDirName)

    // 6.2. 检查并处理已存在的部署目录
    spinner.start('检查部署环境...')
    await handleExistingDeployDir(ssh, config.server.deployPath, buildDirName, spinner)
    // 如果没有需要处理的情况，spinner 仍在运行，所以添加 succeed
    if (spinner.isSpinning) {
      spinner.succeed('部署环境检查完成')
    }

    // 7. 创建版本目录
    const versionDirName = `${buildDirName}-${version}`
    const versionPath = join(config.server.deployPath, versionDirName)
    const currentLinkPath = join(config.server.deployPath, buildDirName)

    spinner.start('正在准备部署目录...')
    // 确保部署路径存在
    const mkDeployResult = await ssh.execCommand(`mkdir -p ${config.server.deployPath}`)
    if (mkDeployResult.code !== 0) {
      throw new Error(`创建部署目录失败: ${mkDeployResult.stderr}`)
    }
    // 创建版本目录
    const mkVersionResult = await ssh.execCommand(`mkdir -p ${versionPath}`)
    if (mkVersionResult.code !== 0) {
      throw new Error(`创建版本目录失败: ${mkVersionResult.stderr}`)
    }
    spinner.succeed('部署目录准备完成')

    // 8. 上传文件
    spinner.start(`正在上传文件到版本目录 ${versionDirName}...`)
    const remoteZipPath = join(versionPath, 'build.zip')
    await ssh.putFile(zipPath, remoteZipPath)
    spinner.succeed('文件上传完成')

    // 9. 在版本目录中解压
    spinner.start('正在解压文件...')
    const unzipResult = await ssh.execCommand(
      `cd ${versionPath} && unzip -o build.zip && rm build.zip`,
    )
    if (unzipResult.code !== 0) {
      throw new Error(`解压文件失败: ${unzipResult.stderr || unzipResult.stdout}`)
    }

    // 将构建目录内容移动到版本目录根部
    const mvResult = await ssh.execCommand(`
      cd ${versionPath} && 
      if [ -d "${buildDirName}" ]; then 
        mv ${buildDirName}/* . 2>/dev/null || true
        mv ${buildDirName}/.[!.]* . 2>/dev/null || true
        rmdir ${buildDirName} 2>/dev/null || true
      fi
    `)
    if (mvResult.code !== 0) {
      throw new Error(`移动构建目录内容失败: ${mvResult.stderr}`)
    }
    spinner.succeed('文件解压完成')

    // 10. 将解压后版本目录内的额外文件复制到 deployPath 根部（与软链接同级）
    if (config.files && config.files.length > 0) {
      spinner.start('正在部署额外文件...')
      for (const file of config.files) {
        const remoteVersionFilePath = join(versionPath, file)
        const remoteRootFilePath = join(config.server.deployPath, file)
        // 使用 test -e 同时支持文件和目录的存在检查
        const checkExists = await ssh.execCommand(`test -e ${remoteVersionFilePath}`)
        if (checkExists.code !== 0) {
          spinner.warn(`额外文件不在版本目录中，已跳过: ${file}`)
          spinner.start('正在部署额外文件...')
          continue
        }
        // 判断是目录还是文件，分别处理
        const checkDir = await ssh.execCommand(`test -d ${remoteVersionFilePath}`)
        if (checkDir.code === 0) {
          // 是目录：确保目标目录存在，用 /. 语法将内容（含深层子目录）合并复制，避免路径嵌套
          const mkdirResult = await ssh.execCommand(`mkdir -p ${remoteRootFilePath}`)
          if (mkdirResult.code !== 0) {
            throw new Error(`创建目录失败: ${mkdirResult.stderr}`)
          }
          const cpResult = await ssh.execCommand(
            `cp -rf ${remoteVersionFilePath}/. ${remoteRootFilePath}/`,
          )
          if (cpResult.code !== 0) {
            throw new Error(`复制额外目录失败 (${file}): ${cpResult.stderr}`)
          }
        } else {
          // 是文件：确保父目录存在，然后复制文件
          const mkdirResult = await ssh.execCommand(
            `mkdir -p ${join(config.server.deployPath, file, '..')}`,
          )
          if (mkdirResult.code !== 0) {
            throw new Error(`创建目录失败: ${mkdirResult.stderr}`)
          }
          const cpResult = await ssh.execCommand(
            `cp -f ${remoteVersionFilePath} ${remoteRootFilePath}`,
          )
          if (cpResult.code !== 0) {
            throw new Error(`复制额外文件失败 (${file}): ${cpResult.stderr}`)
          }
        }
      }
      spinner.succeed(`额外文件部署完成 (${config.files.length} 个)`)
    }

    // 11. 执行部署后命令（在 deployPath 根部执行，与 package.json 等文件同级）
    if (config.afterDeploy) {
      for (const cmd of config.afterDeploy) {
        spinner.start(`执行部署后命令: ${cmd}`)
        const result = await execNodeCommand(ssh, cmd, { cwd: config.server.deployPath })
        if (result.stdout) {
          spinner.stop()
          console.log(result.stdout)
        }
        if (result.stderr) {
          spinner.stop()
          console.error(chalk.yellow(result.stderr))
        }
        if (result.code !== 0) {
          throw new Error(`部署后命令执行失败 (exit ${result.code}): ${cmd}`)
        }
        spinner.succeed(`命令执行完成: ${cmd}`)
      }
    }

    // 12. 原子性切换软链接
    spinner.start(`正在切换到新版本 ${version}...`)
    const tempLinkPath = `${currentLinkPath}.tmp.${Date.now()}`

    try {
      // 创建临时软链接
      const linkResult = await ssh.execCommand(`ln -sfn ${versionPath} ${tempLinkPath}`)
      if (linkResult.code !== 0) {
        throw new Error(`创建临时软链接失败: ${linkResult.stderr}`)
      }

      // 原子性移动（替换）
      const moveResult = await ssh.execCommand(`mv -T ${tempLinkPath} ${currentLinkPath}`)
      if (moveResult.code !== 0) {
        // 如果移动失败，清理临时链接
        await ssh.execCommand(`rm -f ${tempLinkPath}`)
        throw new Error(`切换软链接失败: ${moveResult.stderr}`)
      }

      spinner.succeed(`版本切换完成: ${buildDirName} -> ${versionDirName}`)
    } catch (error) {
      // 确保清理临时链接
      await ssh.execCommand(`rm -f ${tempLinkPath}`)
      throw error
    }

    // 13. PM2 启动
    if (config.pm2) {
      spinner.start('正在启动 PM2 应用...')
      const { appName, restart = true } = config.pm2
      if (restart) {
        // 等待一小段时间确保文件系统操作完成
        await new Promise((resolve) => setTimeout(resolve, 1000))

        const pm2EnvFlag = config.pm2?.env ? ` --env ${config.pm2.env}` : ''
        const result = await execNodeCommand(ssh, `pm2 start ${appName}${pm2EnvFlag}`, {
          cwd: config.server.deployPath,
        })
        if (result.code === 0) {
          spinner.succeed('PM2 应用启动成功')
        } else {
          // 如果启动失败，尝试配置文件
          const startResult = await execNodeCommand(
            ssh,
            `pm2 start ecosystem.config.js${pm2EnvFlag}`,
            {
              cwd: config.server.deployPath,
            },
          )
          if (startResult.code === 0) {
            spinner.succeed('PM2 应用启动成功')
          } else {
            spinner.warn('PM2 操作失败，请手动检查')
            console.log(chalk.yellow(`启动命令: pm2 start ${appName}${pm2EnvFlag}`))
            console.log(chalk.yellow(`启动命令: pm2 start ecosystem.config.js${pm2EnvFlag}`))
          }
        }
      }
    }

    // 14. 清理旧版本（可选，保留最近3个版本）
    spinner.start('正在清理旧版本...')
    await cleanOldVersions(ssh, config.server.deployPath, buildDirName, 3)
    spinner.succeed('旧版本清理完成')

    ssh.dispose()

    // 15. 清理临时文件
    await fse.remove(tempDir)

    console.log(chalk.green('\n🎉 部署完成!'))
    console.log(chalk.blue(`📦 版本: ${version}`))
    console.log(chalk.blue(`🔗 当前链接: ${currentLinkPath} -> ${versionPath}`))

    if (config.pm2) {
      console.log(chalk.blue(`⚡ PM2 应用: ${config.pm2.appName}`))
      console.log(chalk.gray(`   启动文件: ${currentLinkPath}/server/index.mjs`))
    }
  } catch (error) {
    spinner.fail('部署失败')
    console.error(chalk.red(`❌ 错误: ${error}`))

    // 清理临时文件
    await fse.remove(tempDir)
    process.exit(1)
  }
}

/** 压缩 */
async function createZip(
  sourcePath: string,
  outputPath: string,
  excludeFiles: string[] = [],
  extraFiles: { localPath: string; name: string }[] = [],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fse.createWriteStream(outputPath)
    const archive = archiver('zip', { zlib: { level: 9 } })

    output.on('close', () => resolve())
    archive.on('error', (err: Error) => reject(err))

    archive.pipe(output)

    // 添加整个目录，排除指定文件；follow: true 跟踪软链接写入实际内容，避免服务器解压后链接失效
    archive.glob('**/*', {
      cwd: sourcePath,
      ignore: excludeFiles,
      follow: true,
    })

    // 将额外文件添加到压缩包根部（与构建产物同级，不进入构建目录）
    for (const { localPath, name } of extraFiles) {
      if (fse.statSync(localPath).isDirectory()) {
        // 目录：将目录内容（含子目录）打包到压缩包的 name/ 下
        archive.directory(localPath, name)
      } else {
        archive.file(localPath, { name })
      }
    }

    archive.finalize()
  })
}

/** 清理旧版本 */
async function cleanOldVersions(
  ssh: NodeSSH,
  deployPath: string,
  buildDirName: string,
  keepCount: number,
): Promise<void> {
  try {
    // 获取所有版本目录
    const result = await ssh.execCommand(
      `find ${deployPath} -maxdepth 1 -type d -name "${buildDirName}-*" | sort -V`,
    )

    if (result.code !== 0) {
      return // 如果命令失败，跳过清理
    }

    const versionDirs = result.stdout
      .split('\n')
      .filter((dir) => dir.trim())
      .map((dir) => dir.trim())

    // 如果版本数量超过保留数量，删除旧版本
    if (versionDirs.length > keepCount) {
      const dirsToDelete = versionDirs.slice(0, -keepCount)
      for (const dir of dirsToDelete) {
        const rmResult = await ssh.execCommand(`rm -rf "${dir}"`)
        if (rmResult.code !== 0) {
          console.warn(chalk.yellow(`⚠️ 删除旧版本失败 (${dir}): ${rmResult.stderr}`))
        }
      }
    }
  } catch (error) {
    // 清理失败不影响主流程，只记录错误
    console.warn(chalk.yellow(`⚠️ 清理旧版本时出现警告: ${error}`))
  }
}

/** 初始化配置文件 */
export async function initConfig(): Promise<void> {
  console.log(chalk.blue('🚀 初始化配置文件'))

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'envName',
      message: '环境名称 (如: dev, prod, staging):',
      default: 'dev',
      validate: (input) => input.trim() !== '' || '请输入环境名称',
    },
    {
      type: 'input',
      name: 'buildCommand',
      message: '构建命令 (如: npm run build):',
      default: 'npm run build',
    },
    {
      type: 'input',
      name: 'buildDir',
      message: '构建输出目录:',
      default: 'dist',
    },
    {
      type: 'input',
      name: 'host',
      message: '服务器地址:',
      validate: (input) => input.trim() !== '' || '请输入服务器地址',
    },
    {
      type: 'input',
      name: 'port',
      message: '服务器端口:',
      default: '22',
    },
    {
      type: 'input',
      name: 'username',
      message: '用户名:',
      validate: (input) => input.trim() !== '' || '请输入用户名',
    },
    {
      type: 'input',
      name: 'privateKeyPath',
      message: '私钥路径 (留空稍后填写):',
    },
    {
      type: 'input',
      name: 'deployPath',
      message: '服务器部署路径:',
      validate: (input) => input.trim() !== '' || '请输入部署路径',
    },
    {
      type: 'input',
      name: 'pm2AppName',
      message: 'PM2 应用名称 (可选):',
    },
  ])

  // 使用 EJS 模板渲染配置文件
  const configContent = renderConfigTemplate({
    envName: answers.envName,
    buildCommand: answers.buildCommand,
    buildDir: answers.buildDir,
    host: answers.host,
    port: answers.port,
    username: answers.username,
    privateKeyPath: answers.privateKeyPath || undefined,
    deployPath: answers.deployPath,
    pm2AppName: answers.pm2AppName || undefined,
  })

  await fse.writeFile('pcli-cd.config.js', configContent)
  console.log(chalk.green('✅ 配置文件已创建: pcli-cd.config.js'))
  console.log(chalk.blue(`📝 默认环境: ${answers.envName}`))
  console.log(chalk.gray('💡 可以在 apps 数组中添加更多环境配置'))
  console.log(chalk.gray('💡 配置文件包含详细的注释说明'))
}

/** 列出服务器上的版本 */
export async function listVersions(options: ListOptions): Promise<void> {
  const configPath = resolve(process.cwd(), options.config)

  // 读取配置文件并解析环境配置
  const configResult = await resolveEnvConfig(configPath, options.name)

  // 确定环境名称和配置（指定或交互式选择）
  let config: DeployConfig

  if (configResult.targetConfig) {
    // 如果已经指定了环境，直接使用
    config = configResult.targetConfig
  } else {
    // 如果没有指定环境，交互式选择
    const selected = await selectEnvironmentFromConfigs(configResult.allConfigs)
    config = selected.targetConfig
  }

  // 显示当前查看的环境
  console.log(chalk.blue(`🔍 查看环境: ${chalk.bold(config.name)}`))

  const spinner = ora('正在获取版本列表...')
  spinner.start()

  try {
    const ssh = await createSSHConnection(config.server)

    const buildDirName = config.buildDir.split('/').pop() || 'build'
    const currentLinkPath = join(config.server.deployPath, buildDirName)

    // 获取当前激活的版本
    const currentResult = await ssh.execCommand(`readlink ${currentLinkPath}`)
    const currentVersion =
      currentResult.code === 0
        ? currentResult.stdout.trim().split('/').pop()?.replace(`${buildDirName}-`, '') || 'unknown'
        : 'unknown'

    // 获取所有版本
    const result = await ssh.execCommand(
      `find ${config.server.deployPath} -maxdepth 1 -type d -name "${buildDirName}-*" | sort -V`,
    )

    if (result.code !== 0) {
      throw new Error('无法获取版本列表')
    }

    const versions = result.stdout
      .split('\n')
      .filter((dir) => dir.trim())
      .map((dir) => {
        const version = dir.trim().split('/').pop()?.replace(`${buildDirName}-`, '') || ''
        return {
          version,
          path: dir.trim(),
          isCurrent: version === currentVersion,
        }
      })
      .reverse() // 最新的在前面

    spinner.succeed('版本列表获取成功')

    if (versions.length === 0) {
      console.log(chalk.yellow('📦 服务器上没有找到任何版本'))
      return
    }

    console.log(chalk.blue('\n📦 已部署的版本:'))
    console.log('─'.repeat(50))

    versions.forEach((version) => {
      const prefix = version.isCurrent ? chalk.green('●') : chalk.gray('○')
      const label = version.isCurrent ? chalk.green(' (当前)') : ''
      const versionText = version.isCurrent
        ? chalk.green(version.version)
        : chalk.white(version.version)

      console.log(`${prefix} ${versionText}${label}`)
    })

    console.log('─'.repeat(50))
    console.log(chalk.gray(`总计: ${versions.length} 个版本`))

    ssh.dispose()
  } catch (error) {
    spinner.fail('获取版本列表失败')
    console.error(chalk.red(`❌ 错误: ${error}`))
    process.exit(1)
  }
}

/** 回滚到指定版本 */
export async function rollbackVersion(options: RollbackOptions): Promise<void> {
  const configPath = resolve(process.cwd(), options.config)

  // 读取配置文件并解析环境配置
  const configResult = await resolveEnvConfig(configPath, options.name)

  // 确定环境名称和配置（指定或交互式选择）
  let config: DeployConfig

  if (configResult.targetConfig) {
    // 如果已经指定了环境，直接使用
    config = configResult.targetConfig
  } else {
    // 如果没有指定环境，交互式选择
    const selected = await selectEnvironmentFromConfigs(configResult.allConfigs)
    config = selected.targetConfig
  }

  // 显示当前回滚的环境
  console.log(chalk.blue(`⏪ 回滚环境: ${chalk.bold(config.name)}`))

  const buildDirName = config.buildDir.split('/').pop() || 'build'

  // 如果没有指定版本，列出版本让用户选择
  let targetVersion = options.version
  if (!targetVersion) {
    const ssh = await createSSHConnection(config.server)

    const result = await ssh.execCommand(
      `find ${config.server.deployPath} -maxdepth 1 -type d -name "${buildDirName}-*" | sort -V`,
    )

    if (result.code !== 0) {
      console.log(chalk.red('❌ 无法获取版本列表'))
      process.exit(1)
    }

    const versions = result.stdout
      .split('\n')
      .filter((dir) => dir.trim())
      .map((dir) => dir.trim().split('/').pop()?.replace(`${buildDirName}-`, '') || '')
      .filter(Boolean)
      .reverse()

    if (versions.length === 0) {
      console.log(chalk.yellow('📦 服务器上没有找到任何可回滚的版本'))
      ssh.dispose()
      return
    }

    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'version',
        message: '选择要回滚到的版本:',
        choices: versions,
      },
    ])

    targetVersion = answers.version
    ssh.dispose()
  }

  if (!targetVersion) {
    throw new Error('未指定回滚版本')
  }

  await performRollback(config, targetVersion, buildDirName)
}

/** 执行回滚操作 */
async function performRollback(
  config: DeployConfig,
  targetVersion: string,
  buildDirName: string,
): Promise<void> {
  const spinner = ora()

  try {
    spinner.start('正在连接服务器...')
    const ssh = await createSSHConnection(config.server)
    spinner.succeed('服务器连接成功')

    const versionDirName = `${buildDirName}-${targetVersion}`
    const versionPath = join(config.server.deployPath, versionDirName)
    const currentLinkPath = join(config.server.deployPath, buildDirName)

    // 检查目标版本是否存在
    spinner.start('正在检查目标版本...')
    const checkResult = await ssh.execCommand(`test -d ${versionPath}`)
    if (checkResult.code !== 0) {
      throw new Error(`版本 ${targetVersion} 不存在`)
    }
    spinner.succeed('目标版本检查通过')

    // 原子性切换软链接
    spinner.start(`正在回滚到版本 ${targetVersion}...`)
    const tempLinkPath = `${currentLinkPath}.tmp.${Date.now()}`

    try {
      // 创建临时软链接
      const linkResult = await ssh.execCommand(`ln -sfn ${versionPath} ${tempLinkPath}`)
      if (linkResult.code !== 0) {
        throw new Error(`创建临时软链接失败: ${linkResult.stderr}`)
      }

      // 原子性移动（替换）
      const moveResult = await ssh.execCommand(`mv -T ${tempLinkPath} ${currentLinkPath}`)
      if (moveResult.code !== 0) {
        // 如果移动失败，清理临时链接
        await ssh.execCommand(`rm -f ${tempLinkPath}`)
        throw new Error(`切换软链接失败: ${moveResult.stderr}`)
      }

      spinner.succeed(`回滚完成: ${buildDirName} -> ${versionDirName}`)
    } catch (error) {
      // 确保清理临时链接
      await ssh.execCommand(`rm -f ${tempLinkPath}`)
      throw error
    }

    // 从目标版本目录还原额外文件到 deployPath 根部
    if (config.files && config.files.length > 0) {
      spinner.start('正在还原额外文件...')
      for (const file of config.files) {
        const remoteVersionFilePath = join(versionPath, file)
        const remoteRootFilePath = join(config.server.deployPath, file)
        // 检查版本目录中是否存在该文件（旧版本可能没有）
        const checkFile = await ssh.execCommand(`test -f ${remoteVersionFilePath}`)
        if (checkFile.code !== 0) {
          spinner.warn(`版本 ${targetVersion} 中不存在文件 ${file}，已跳过`)
          spinner.start('正在还原额外文件...')
          continue
        }
        const mkdirResult = await ssh.execCommand(
          `mkdir -p ${join(config.server.deployPath, file, '..')}`,
        )
        if (mkdirResult.code !== 0) {
          throw new Error(`创建目录失败: ${mkdirResult.stderr}`)
        }
        const cpResult = await ssh.execCommand(
          `cp -f ${remoteVersionFilePath} ${remoteRootFilePath}`,
        )
        if (cpResult.code !== 0) {
          throw new Error(`还原额外文件失败 (${file}): ${cpResult.stderr}`)
        }
      }
      spinner.succeed('额外文件还原完成')
    }

    // 重启 PM2
    if (config.pm2) {
      spinner.start('正在重启 PM2 应用...')
      const { appName } = config.pm2

      // 等待一小段时间确保文件系统操作完成
      await new Promise((resolve) => setTimeout(resolve, 1000))

      const pm2EnvFlag = config.pm2?.env ? ` --env ${config.pm2.env}` : ''
      const result = await execNodeCommand(ssh, `pm2 start ${appName}${pm2EnvFlag}`, {
        cwd: config.server.deployPath,
      })
      if (result.code === 0) {
        spinner.succeed('PM2 应用启动成功')
      } else {
        spinner.warn('PM2 启动失败，请手动检查')
        console.log(chalk.yellow(`启动命令: pm2 start ${appName}${pm2EnvFlag}`))
      }
    }

    ssh.dispose()

    console.log(chalk.green('\n🎉 回滚完成!'))
    console.log(chalk.blue(`📦 当前版本: ${targetVersion}`))
    console.log(chalk.blue(`🔗 当前链接: ${currentLinkPath} -> ${versionPath}`))

    if (config.pm2) {
      console.log(chalk.blue(`⚡ PM2 应用: ${config.pm2.appName}`))
    }
  } catch (error) {
    spinner.fail('回滚失败')
    console.error(chalk.red(`❌ 错误: ${error}`))
    process.exit(1)
  }
}

/**
 * 读取配置文件并解析环境配置
 * @param configPath 配置文件路径
 * @param envName 环境名称，可选
 * @returns 解析结果，包含目标配置和所有配置
 */
async function resolveEnvConfig(configPath: string, envName?: string): Promise<EnvConfigResult> {
  // 检查配置文件是否存在
  if (!existsSync(configPath)) {
    console.log(chalk.red(`❌ 配置文件不存在: ${configPath}`))
    console.log(chalk.yellow('💡 请创建 pcli-cd.config.js 配置文件'))
    process.exit(1)
  }

  // 读取并解析配置文件
  let rawConfig: MultiEnvConfig
  try {
    // 支持 ES 模块和 CommonJS 两种格式
    const configModule = await import(configPath)
    rawConfig = configModule.default || configModule
  } catch (error) {
    console.log(chalk.red(`❌ 配置文件读取失败: ${error}`))
    process.exit(1)
  }

  // 检查配置文件格式
  if (!rawConfig.apps || !Array.isArray(rawConfig.apps)) {
    console.log(chalk.red('❌ 配置文件格式错误：缺少 apps 数组'))
    console.log(chalk.yellow('💡 配置文件应该包含一个 apps 数组，每个元素都是一个环境配置'))
    process.exit(1)
  }

  if (rawConfig.apps.length === 0) {
    console.log(chalk.red('❌ 配置文件中没有任何环境配置'))
    console.log(chalk.yellow('💡 请在 apps 数组中添加至少一个环境配置'))
    process.exit(1)
  }

  // 如果没有指定环境名称，返回所有配置，targetConfig为null
  if (!envName) {
    return {
      targetConfig: null,
      allConfigs: rawConfig.apps,
    }
  }

  // 查找指定的环境配置
  const envConfig = rawConfig.apps.find((app) => app.name === envName)
  if (!envConfig) {
    console.log(chalk.red(`❌ 环境配置 "${envName}" 不存在`))
    console.log(chalk.yellow('💡 可用的环境配置:'))

    rawConfig.apps.forEach((app) => {
      console.log(chalk.gray(`   - ${app.name}`))
    })

    process.exit(1)
  }

  return {
    targetConfig: envConfig,
    allConfigs: rawConfig.apps,
  }
}

/**
 * 交互式选择环境并返回环境配置
 * @param allConfigs 所有环境配置
 * @returns 选择的环境名称和对应的配置
 */
async function selectEnvironmentFromConfigs(allConfigs: DeployConfig[]): Promise<{
  envName: string
  targetConfig: DeployConfig
}> {
  // 如果只有一个环境，直接返回
  if (allConfigs.length === 1) {
    return {
      envName: allConfigs[0].name,
      targetConfig: allConfigs[0],
    }
  }

  // 交互式选择环境
  const envChoices = allConfigs.map((app) => ({
    name: `${app.name} (${app.server.host})`,
    value: app.name,
  }))

  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'envName',
      message: '请选择环境:',
      choices: envChoices,
    },
  ])

  const selectedConfig = allConfigs.find((app) => app.name === answers.envName)!

  return {
    envName: answers.envName,
    targetConfig: selectedConfig,
  }
}

/**
 * 创建 SSH 连接
 * @param server 服务器配置
 * @returns SSH 连接实例
 */
async function createSSHConnection(server: DeployConfig['server']): Promise<NodeSSH> {
  const ssh = new NodeSSH()

  // 准备连接配置
  const connectConfig: {
    host: string
    port: number
    username: string
    password?: string
    privateKey?: string
    privateKeyPath?: string
  } = {
    host: server.host,
    port: server.port || 22,
    username: server.username,
  }

  // 优先级：privateKey > privateKeyPath > password
  if (server.privateKey) {
    connectConfig.privateKey = server.privateKey
  } else if (server.privateKeyPath) {
    connectConfig.privateKeyPath = server.privateKeyPath
  } else if (server.password) {
    connectConfig.password = server.password
  } else {
    throw new Error('SSH 认证配置错误：必须提供 password、privateKey 或 privateKeyPath 之一')
  }

  try {
    await ssh.connect(connectConfig)
    return ssh
  } catch (error: unknown) {
    throw new Error(`SSH 连接失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 在 SSH 中执行需要 Node.js 环境的命令
 * 通过 bash -l 登录 shell 并 source 各类 profile 文件，确保 nvm/fnm/系统 Node.js 的 PATH 正常注入
 * 同时设置 PS1 以绕过 .bashrc 开头的 [ -z "$PS1" ] && return 守卫
 */
async function execNodeCommand(
  ssh: NodeSSH,
  cmd: string,
  options?: { cwd?: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const inner = [
    'export PS1="x"',
    '[ -f /etc/profile ] && . /etc/profile 2>/dev/null || true',
    '[ -f ~/.bash_profile ] && . ~/.bash_profile 2>/dev/null || true',
    '[ -f ~/.bashrc ] && . ~/.bashrc 2>/dev/null || true',
    cmd,
  ].join('; ')
  return ssh.execCommand(`bash -l -c ${JSON.stringify(inner)}`, options)
}

/**
 * 清理残留的临时软链接
 * @param ssh SSH 连接
 * @param deployPath 部署路径
 * @param buildDirName 构建目录名
 */
async function cleanTempLinks(
  ssh: NodeSSH,
  deployPath: string,
  buildDirName: string,
): Promise<void> {
  try {
    // 查找并删除所有临时链接文件
    const result = await ssh.execCommand(
      `find ${deployPath} -name "${buildDirName}.tmp.*" -type l -delete`,
    )
    if (result.code !== 0) {
      console.warn(chalk.yellow(`⚠️ 清理临时链接时出现警告: ${result.stderr}`))
    }
  } catch (error) {
    // 清理失败不影响主流程
    console.warn(chalk.yellow(`⚠️ 清理临时链接时出现警告: ${error}`))
  }
}

/**
 * 检查并处理已存在的部署目录
 * @param ssh SSH连接
 * @param deployPath 部署路径
 * @param buildDirName 构建目录名
 * @param spinner Spinner 实例，用于控制加载状态
 */
async function handleExistingDeployDir(
  ssh: NodeSSH,
  deployPath: string,
  buildDirName: string,
  spinner: ReturnType<typeof ora>,
): Promise<void> {
  const currentLinkPath = join(deployPath, buildDirName)

  // 检查是否存在
  const checkResult = await ssh.execCommand(`test -e ${currentLinkPath}`)
  if (checkResult.code !== 0) {
    // 不存在，无需处理
    return
  }

  // 检查是否为软链接
  const linkCheckResult = await ssh.execCommand(`test -L ${currentLinkPath}`)
  if (linkCheckResult.code === 0) {
    // 是软链接，正常情况
    return
  }

  // 是目录或文件，需要处理
  const typeResult = await ssh.execCommand(
    `stat -c %F ${currentLinkPath} 2>/dev/null || file -b ${currentLinkPath}`,
  )
  const fileType = typeResult.stdout.trim()

  if (fileType.includes('directory') || fileType === 'directory') {
    // 是目录，需要备份并移除
    const backupPath = `${currentLinkPath}.backup.${Date.now()}`

    // 停止 spinner 并显示信息
    spinner.stop()
    console.log(chalk.yellow(`⚠️ 检测到已存在的目录: ${currentLinkPath}`))
    console.log(chalk.blue(`📁 将备份到: ${backupPath}`))

    // 询问用户是否继续
    const answers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'proceed',
        message: '是否继续部署？（已存在的目录将被备份）',
        default: true,
      },
    ])

    if (!answers.proceed) {
      throw new Error('用户取消部署')
    }

    // 重新启动 spinner 进行备份
    spinner.start('正在备份已存在的目录...')
    const backupResult = await ssh.execCommand(`mv ${currentLinkPath} ${backupPath}`)
    if (backupResult.code !== 0) {
      throw new Error(`备份目录失败: ${backupResult.stderr}`)
    }

    spinner.stop()
    console.log(chalk.green(`✅ 目录已备份到: ${backupPath}`))
  } else {
    // 是文件，直接备份
    const backupPath = `${currentLinkPath}.backup.${Date.now()}`

    // 停止 spinner 并显示信息
    spinner.stop()
    console.log(chalk.yellow(`⚠️ 检测到已存在的文件: ${currentLinkPath}`))
    console.log(chalk.blue(`📁 将备份到: ${backupPath}`))

    // 重新启动 spinner 进行备份
    spinner.start('正在备份已存在的文件...')
    const backupResult = await ssh.execCommand(`mv ${currentLinkPath} ${backupPath}`)
    if (backupResult.code !== 0) {
      throw new Error(`备份文件失败: ${backupResult.stderr}`)
    }

    spinner.stop()
    console.log(chalk.green(`✅ 文件已备份到: ${backupPath}`))
  }
}
