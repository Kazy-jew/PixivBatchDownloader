// 定义每个页面的抓取流程
import { FilterOption } from './Filter.d'
import { IllustData } from './CrawlResult.d'
import { filter } from './Filter'
import { lang } from './Lang'
import { API } from './API'
import { store } from './Store'
import { log } from './Log'
import { EVT } from './EVT'
import { ui } from './UI'
import { titleBar } from './TitleBar'
import { pageInfo } from './PageInfo'

/*
  一般流程：
  准备抓取
  获取作品列表
  获取作品列表完毕
  获取作品信息
  获取作品信息完毕
  */

abstract class CrawlPageBase {
  protected crawlNumber: number = 0 // 要抓取的个数/页数

  protected imgNumberPerWork: number = 0 // 每个作品下载几张图片。0为不限制，全部下载。改为1则只下载第一张。这是因为有时候多p作品会导致要下载的图片过多，此时可以设置只下载前几张，减少下载量

  public maxCount = 1000 // 当前页面类型最多有多少个页面/作品

  protected startpageNo: number = 1 // 列表页开始抓取时的页码，只在 api 需要页码时使用。目前有搜索页、排行榜页、关注的新作品页使用。

  protected listPageFinished: number = 0 // 记录一共抓取了多少个列表页。使用范围同上。

  protected readonly ajaxThreadsDefault: number = 10 // 抓取时的并发连接数默认值，也是最大值

  protected ajaxThreads: number = this.ajaxThreadsDefault // 抓取时的并发连接数

  protected ajaxThreadsFinished: number = 0 // 统计有几个并发线程完成所有请求。统计的是并发线程（ ajaxThreads ）而非请求数

  // 作品个数/页数的输入不合法
  private getWantPageError() {
    EVT.fire(EVT.events.crawlError)
    const msg = lang.transl('_参数不合法')
    window.alert(msg)
    throw new Error(msg)
  }

  // 检查用户输入的页数/个数设置，并返回提示信息
  // 可以为 -1，或者大于 0
  protected checkWantPageInput(crawlPartTip: string, crawlAllTip: string) {
    const temp = parseInt(ui.form.setWantPage.value)

    // 如果比 1 小，并且不是 -1，则不通过
    if ((temp < 1 && temp !== -1) || isNaN(temp)) {
      // 比 1 小的数里，只允许 -1 , 0 也不行
      this.getWantPageError()
    }

    if (temp >= 1) {
      log.warning(crawlPartTip.replace('-num-', temp.toString()))
    } else if (temp === -1) {
      log.warning(crawlAllTip)
    }

    return temp
  }

  // 检查用户输入的页数/个数设置
  // 必须大于 0
  protected checkWantPageInputGreater0() {
    const result = API.checkNumberGreater0(ui.form.setWantPage.value)

    if (result.result) {
      return result.value
    } else {
      this.getWantPageError()
    }
  }

  // 获取作品张数设置
  private getImgNumberPerWork() {
    const check = API.checkNumberGreater0(ui.form.imgNumberPerWork.value)

    if (check.result) {
      log.warning(lang.transl('_作品张数提醒', check.value.toString()))
      return check.value
    } else {
      return 0
    }
  }

  // 设置要获取的作品数或页数。有些页面使用，有些页面不使用。使用时再具体定义
  protected getWantPage() {}

  private checkNotAllowPage() {
    if (location.href.includes('novel')) {
      window.alert('Not support novel page!')
      throw new Error('Not support novel page!')
    }

    if (location.href.includes('/tags.php')) {
      window.alert('Not support page!')
      throw new Error('Not support page!')
    }
  }

  // 准备抓取，进行抓取之前的一些检查工作。必要时可以在子类中改写
  public async readyCrawl() {
    // 检查是否可以开始抓取
    this.checkNotAllowPage()

    if (!store.states.allowWork) {
      window.alert(lang.transl('_当前任务尚未完成2'))
      return
    }

    EVT.fire(EVT.events.crawlStart)

    log.clear()

    log.success(lang.transl('_任务开始0'))

    titleBar.changeTitle('↑')

    ui.hideCenterPanel()

    this.getWantPage()

    filter.init()

    // 检查是否设置了作品张数限制
    this.imgNumberPerWork = this.getImgNumberPerWork()

    await pageInfo.store()

    // 进入第一个抓取方法
    this.nextStep()
  }

  // 当可以开始抓取时，进入下一个流程。默认情况下，开始获取作品列表。如有不同，由子类具体定义
  protected nextStep() {
    this.getIdList()
  }

  // 获取作品列表，由各个子类具体定义
  protected abstract getIdList(): void

  // 作品列表获取完毕，开始抓取作品内容页
  protected getIdListFinished() {
    // 列表页获取完毕后，可以在这里重置一些变量
    this.resetGetIdListStatus()

    if (store.idList.length === 0) {
      return this.noResult()
    }

    if (store.idList.length <= this.ajaxThreadsDefault) {
      this.ajaxThreads = store.idList.length
    } else {
      this.ajaxThreads = this.ajaxThreadsDefault
    }

    for (let i = 0; i < this.ajaxThreads; i++) {
      this.getWorksData()
    }
  }

  // 获取作品的数据
  // 在重试时会传入要重试的 id
  protected async getWorksData(id?: string) {
    id = id || store.idList.shift()!

    let data: IllustData
    try {
      // 发起请求
      data = await API.getWorksData(id)
    } catch (error) {
      //  请求成功，但 response.ok 错误。不重试请求，跳过该作品继续抓取
      if (error.status) {
        this.logErrorStatus(error.status, id)
        this.afterGetWorksData()
      } else {
        // 请求失败，会重试这个请求
        setTimeout(() => {
          this.getWorksData(id)
        }, 2000)
      }

      return
    }

    // 获取需要检查的信息
    const body = data.body
    const fullWidth = body.width // 原图宽度
    const fullHeight = body.height // 原图高度
    const bmk = body.bookmarkCount // 收藏数
    const tagArr = body.tags.tags // 取出 tag 信息
    const tags: string[] = [] // 保存 tag 列表
    const tagTranslation: string[] = [] // 保存 tag 列表，附带翻译后的 tag

    for (const tagData of tagArr) {
      tags.push(tagData.tag)
      tagTranslation.push(tagData.tag)
      if (tagData.translation && tagData.translation.en) {
        tagTranslation.push(tagData.translation.en)
      }
    }

    const filterOpt: FilterOption = {
      illustType: body.illustType,
      tags: tags,
      bookmarkCount: bmk,
      bookmarkData: body.bookmarkData,
      width: fullWidth,
      height: fullHeight
    }

    // 检查通过
    if (filter.check(filterOpt)) {
      const illustId = body.illustId
      const title = body.illustTitle // 作品标题
      const userid = body.userId // 用户id
      const user = body.userName // 用户名

      let rank = '' // 保存作品在排行榜上的编号
      let testRank = store.getRankList(body.illustId)
      if (testRank !== undefined) {
        rank = '#' + testRank
      }

      // 储存作品信息
      if (body.illustType !== 2) {
        // 插画或漫画

        // 下载该作品的前面几张
        let pNo = body.pageCount
        if (this.imgNumberPerWork > 0 && this.imgNumberPerWork <= pNo) {
          pNo = this.imgNumberPerWork
        }

        const imgUrl = body.urls.original // 作品的原图 URL

        const tempExt = imgUrl.split('.')
        const ext = tempExt[tempExt.length - 1]

        // 添加作品信息
        // 通过循环添加每个图片的 id 和 url
        for (let i = 0; i < pNo; i++) {
          store.addResult({
            id: illustId + '_p' + i,
            url: imgUrl.replace('p0', 'p' + i),
            title: title,
            tags: tags,
            tagsTranslated: tagTranslation,
            user: user,
            userid: userid,
            fullWidth: fullWidth,
            fullHeight: fullHeight,
            ext: ext,
            bmk: bmk,
            date: body.createDate.split('T')[0],
            type: body.illustType,
            rank: rank
          })
        }
        this.outputImgNum()
      } else if (body.illustType === 2) {
        // 动图
        // 获取动图的信息
        const meta = await API.getUgoiraMeta(illustId)
        // 动图帧延迟数据
        const ugoiraInfo = {
          frames: meta.body.frames,
          mime_type: meta.body.mime_type
        }

        const ext = ui.form.ugoiraSaveAs.value // 扩展名可能是 webm、gif、zip

        store.addResult({
          id: illustId,
          url: meta.body.originalSrc,
          title: title,
          tags: tags,
          tagsTranslated: tagTranslation,
          user: user,
          userid: userid,
          fullWidth: fullWidth,
          fullHeight: fullHeight,
          ext: ext,
          bmk: bmk,
          date: body.createDate.split('T')[0],
          type: body.illustType,
          rank: rank,
          ugoiraInfo: ugoiraInfo
        })

        this.outputImgNum()
      }
    }

    this.afterGetWorksData()
  }

  // 每当获取完一个作品的信息
  private afterGetWorksData() {
    if (store.idList.length > 0) {
      // 如果存在下一个作品，则
      this.getWorksData()
    } else {
      // 没有剩余作品
      this.ajaxThreadsFinished++
      if (this.ajaxThreadsFinished === this.ajaxThreads) {
        // 如果所有并发请求都执行完毕，复位
        this.ajaxThreadsFinished = 0
        this.crawFinished()
      }
    }
  }

  // 抓取完毕
  protected crawFinished() {
    if (store.result.length === 0) {
      return this.noResult()
    }

    this.sortResult()

    log.log(lang.transl('_抓取完毕'), 2)

    EVT.fire(EVT.events.crawlFinish)

    // 显示中间面板
    if (!store.states.quickDownload) {
      ui.showCenterPanel()
    }
  }

  // 重设抓取作品列表时使用的变量或标记
  protected abstract resetGetIdListStatus(): void

  // 网络请求状态异常时输出提示
  private logErrorStatus(status: number, id: string) {
    log.error(lang.transl('_无权访问2', id), 1)

    switch (status) {
      case 0:
        console.log(lang.transl('_作品页状态码0'))
        break

      case 400:
        console.log(lang.transl('_作品页状态码400'))
        break

      case 403:
        console.log(lang.transl('_作品页状态码403'))
        break

      case 404:
        console.log(lang.transl('_作品页状态码404') + ' ' + id)
        break

      default:
        break
    }
  }

  // 在抓取图片网址时，输出提示
  protected outputImgNum() {
    log.log(
      lang.transl('_抓取图片网址的数量', store.result.length.toString()),
      1,
      false
    )
  }

  // 抓取结果为 0 时输出提示
  protected noResult() {
    EVT.fire(EVT.events.crawlEmpty)
    titleBar.reset()
    log.error(lang.transl('_抓取结果为零'), 2)
    window.alert(lang.transl('_抓取结果为零'))
  }

  // 抓取完成后，对结果进行排序
  protected sortResult() {}
}
export { CrawlPageBase }