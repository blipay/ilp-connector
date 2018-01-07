'use strict'

import BigNumber from 'bignumber.js'
import NoRouteFoundError from '../errors/no-route-found-error'
import UnacceptableExpiryError from '../errors/unacceptable-expiry-error'
import UnacceptableAmountError from '../errors/unacceptable-amount-error'
import LedgerNotConnectedError from '../errors/ledger-not-connected-error'
import InvalidAmountSpecifiedError from '../errors/invalid-amount-specified-error'
import InvalidPacketError from '../errors/invalid-packet-error'
import UnreachableError from '../errors/unreachable-error'
import InsufficientTimeoutError from '../errors/insufficient-timeout-error'
import Accounts from './accounts'
import RoutingTable from './routing-table'
import RateBackend from './rate-backend'
import Quoter from './quoter'
import Config from './config'
import LiquidityCurve from '../routing/liquidity-curve'
import reduct = require('reduct')
import { IlpPrepare } from 'ilp-packet'
import { create as createLogger } from '../common/log'
const log = createLogger('route-builder')

const PROBE_AMOUNT = new BigNumber(10).pow(14).toNumber() // stays within 15 max digits for BigNumber from Number

function rateToCurve (rate: number) {
  // Make sure that neither amount exceeds 15 significant digits.
  if (rate > 1) {
    return new LiquidityCurve([ [0, 0], [ PROBE_AMOUNT / rate, PROBE_AMOUNT ] ])
  } else {
    return new LiquidityCurve([ [0, 0], [ PROBE_AMOUNT, PROBE_AMOUNT * rate ] ])
  }
}

export interface QuoteLiquidityParams {
  sourceAccount: string
  destinationAccount: string
  destinationHoldDuration: number
}

export interface QuoteBySourceParams {
  sourceAccount: string
  destinationAccount: string
  sourceAmount: string
  destinationHoldDuration: number
}

export interface QuoteByDestinationParams {
  sourceAccount: string
  destinationAccount: string
  destinationAmount: string
  destinationHoldDuration: number
}

export default class RouteBuilder {
  protected accounts: Accounts
  protected routingTable: RoutingTable
  protected backend: RateBackend
  protected quoter: Quoter
  protected config: Config

  protected isTrivialRate: boolean

  constructor (deps: reduct.Injector) {
    this.accounts = deps(Accounts)
    this.routingTable = deps(RoutingTable)
    this.backend = deps(RateBackend)
    this.quoter = deps(Quoter)
    this.config = deps(Config)

    this.isTrivialRate =
      this.config.backend === 'one-to-one' &&
      this.config.spread === 0
  }

  getNextHop (sourceAccount: string, destinationAccount: string) {
    const route = this.routingTable.resolve(destinationAccount)

    if (!route) {
      log.info('no route found for quote. destinationAccount=' + destinationAccount)
      throw new NoRouteFoundError('no route found. to=' + destinationAccount)
    }

    if (!this.config.reflectPayments && sourceAccount === route.nextHop) {
      log.info('refusing to route payments back to sender. sourceAccount=%s destinationAccount=%s', sourceAccount, destinationAccount)
      throw new NoRouteFoundError('refusing to route payments back to sender. sourceAccount=' + sourceAccount + ' destinationAccount=' + destinationAccount)
    }

    return route.nextHop
  }

  async quoteLocal (sourceAccount: string, destinationAccount: string) {
    if (!this.accounts.getAssetCode(sourceAccount)) {
      log.info('source account is unavailable. sourceAccount=' + sourceAccount)
      throw new NoRouteFoundError('no route from source. sourceAccount=' + sourceAccount)
    }

    const nextHop = this.getNextHop(sourceAccount, destinationAccount)

    if (!this.accounts.getAssetCode(nextHop)) {
      log.info('next hop is unavailable. nextHop=' + nextHop)
      throw new NoRouteFoundError('no route to next hop. nextHop=' + nextHop)
    }

    log.debug('determined next hop. nextHop=' + nextHop)

    const rate = await this.backend.getRate(sourceAccount, nextHop)

    log.debug('determined local rate. rate=' + rate)

    return { nextHop, rate }
  }

  /**
   * @param {Object} params
   * @param {String} params.sourceAccount
   * @param {String} params.destinationAccount
   * @param {Number} params.destinationHoldDuration
   * @returns {QuoteLiquidityResponse}
   */
  async quoteLiquidity (params: QuoteLiquidityParams) {
    log.info('creating liquidity quote. sourceAccount=%s destinationAccount=%s',
      params.sourceAccount, params.destinationAccount)

    const { nextHop, rate } = await this.quoteLocal(params.sourceAccount, params.destinationAccount)
    const localQuoteExpiry = Date.now() + (this.config.quoteExpiry)

    const localCurve = rateToCurve(rate)

    let liquidityCurve
    let appliesToPrefix
    let sourceHoldDuration
    let expiresAt
    if (params.destinationAccount.startsWith(nextHop)) {
      log.debug('local destination.')
      liquidityCurve = localCurve
      appliesToPrefix = nextHop
      sourceHoldDuration = params.destinationHoldDuration + this.config.minMessageWindow
      expiresAt = localQuoteExpiry
    } else {
      const quote = await this.quoter.quoteLiquidity(nextHop, params.destinationAccount)
      if (!quote) {
        log.info('no quote found. params=%j', params)
        throw new NoRouteFoundError('no quote found. to=' + params.destinationAccount)
      }
      log.debug('remote destination. quote=%j', quote)

      liquidityCurve = localCurve.join(quote.curve)
      appliesToPrefix = quote.prefix
      sourceHoldDuration = params.destinationHoldDuration + quote.minMessageWindow + this.config.minMessageWindow
      expiresAt = Math.min(Number(quote.expiry), localQuoteExpiry)
    }

    this._verifyPluginIsConnected(nextHop)
    this._validateHoldDurations(sourceHoldDuration, params.destinationHoldDuration)

    const shiftBy = this._getScaleAdjustment(params.sourceAccount, nextHop)

    return {
      // Shifting the curve right by one unit effectively makes it so the client
      // always sends enough money even despite rounding errors.
      liquidityCurve: liquidityCurve.shiftX(shiftBy).toBuffer(),
      // We need to say which prefix this curve applies to. But for that
      // prefix, the curve must ALWAYS apply because people may cache it.
      // So we need the shortest prefix of the destination for which this
      // cached curve will ALWAYS apply.
      appliesToPrefix: this.routingTable.getShortestUnambiguousPrefix(params.destinationAccount, appliesToPrefix),
      sourceHoldDuration,
      expiresAt: new Date(expiresAt)
    }
  }

  _getScaleAdjustment (sourceAccount: string, destinationAccount: string) {
    const sourceScale = this.accounts.getInfo(sourceAccount).assetScale
    const destinationScale = this.accounts.getInfo(destinationAccount).assetScale
    if (sourceScale === destinationScale && this.isTrivialRate) return 0
    return 1
  }

  /**
   * @param {Object} params
   * @param {String} params.sourceAccount
   * @param {String} params.destinationAccount
   * @param {Number} params.destinationHoldDuration
   * @param {String} params.sourceAmount
   * @returns {QuoteBySourceResponse}
   */
  async quoteBySource (params: QuoteBySourceParams) {
    log.info('creating quote by source amount. sourceAccount=%s destinationAccount=%s sourceAmount=%s',
      params.sourceAccount, params.destinationAccount, params.sourceAmount)

    if (params.sourceAmount === '0') {
      throw new InvalidAmountSpecifiedError('sourceAmount must be positive')
    }

    const { nextHop, rate } = await this.quoteLocal(params.sourceAccount, params.destinationAccount)

    const nextAmount = new BigNumber(params.sourceAmount).times(rate).floor().toString()
    let destinationAmount
    let sourceHoldDuration
    if (params.destinationAccount.startsWith(nextHop)) {
      log.debug('local destination. destinationAmount=' + nextAmount)
      destinationAmount = nextAmount
      sourceHoldDuration = params.destinationHoldDuration + this.config.minMessageWindow
    } else {
      const quote = await this.quoter.quoteLiquidity(nextHop, params.destinationAccount)
      if (!quote) {
        log.info('no quote found. params=%j', params)
        throw new NoRouteFoundError('no quote found. to=' + params.destinationAccount)
      }
      log.debug('remote destination. quote=%j', quote)

      destinationAmount = quote.curve.amountAt(params.sourceAmount).times(rate).floor().toString()
      sourceHoldDuration = params.destinationHoldDuration + quote.minMessageWindow + this.config.minMessageWindow
    }

    if (destinationAmount === '0') {
      throw new UnacceptableAmountError('quoted destination is lower than minimum amount allowed.')
    }

    this._verifyPluginIsConnected(params.sourceAccount)
    this._verifyPluginIsConnected(nextHop)
    this._validateHoldDurations(sourceHoldDuration, params.destinationHoldDuration)

    return {
      destinationAmount,
      sourceHoldDuration
    }
  }

  /**
   * @param {Object} params
   * @param {String} params.sourceAccount
   * @param {String} params.destinationAccount
   * @param {Number} params.destinationHoldDuration
   * @param {String} params.destinationAmount
   * @returns {QuoteByDestinationResponse}
   */
  async quoteByDestination (params: QuoteByDestinationParams) {
    log.info('creating quote by destination amount. sourceAccount=%s destinationAccount=%s destinationAmount=%s',
      params.sourceAccount, params.destinationAccount, params.destinationAmount)

    if (params.destinationAmount === '0') {
      throw new InvalidAmountSpecifiedError('destinationAmount must be positive')
    }

    const { nextHop, rate } = await this.quoteLocal(params.sourceAccount, params.destinationAccount)

    let nextHopAmount
    let nextHopHoldDuration
    if (params.destinationAccount.startsWith(nextHop)) {
      log.debug('local destination.')
      nextHopAmount = params.destinationAmount
      nextHopHoldDuration = params.destinationHoldDuration
    } else {
      const quote = await this.quoter.quoteLiquidity(nextHop, params.destinationAccount)
      if (!quote) {
        log.info('no quote found. params=%j', params)
        throw new NoRouteFoundError('no quote found. to=' + params.destinationAccount)
      }
      log.debug('remote destination. quote=%j', quote)

      nextHopAmount = quote.curve.amountReverse(params.destinationAmount).toString()
      nextHopHoldDuration = params.destinationHoldDuration + quote.minMessageWindow
    }

    const sourceAmount = new BigNumber(nextHopAmount).div(rate).ceil().toString()
    const sourceHoldDuration = nextHopHoldDuration + this.config.minMessageWindow
    if (sourceAmount === '0') {
      throw new UnacceptableAmountError('Quoted source is lower than minimum amount allowed')
    }
    this._verifyPluginIsConnected(params.sourceAccount)
    this._verifyPluginIsConnected(nextHop)
    this._validateHoldDurations(sourceHoldDuration, params.destinationHoldDuration)
    return {
      sourceAmount,
      sourceHoldDuration
    }
  }

  /**
   * @typedef {Object} NextHopPacketInfo
   * @property {string} nextHop Address of the next peer to forward the packet to
   * @property {Buffer} nextHopPacket Outgoing packet
   */

  /**
   * Get next ILP prepare packet.
   *
   * Given a previous ILP prepare packet, returns the next ILP prepare packet in
   * the chain.
   *
   * @param {string} sourceAccount ILP address of our peer who sent us the packet
   * @param {IlpPrepare} sourcePacket (Parsed packet that we received
   * @returns {NextHopPacketInfo} Account and packet for next hop
   */
  async getNextHopPacket (sourceAccount: string, sourcePacket: IlpPrepare) {
    const {
      amount,
      executionCondition,
      expiresAt,
      destination,
      data
    } = sourcePacket

    log.info(
      'constructing next hop packet. sourceAccount=%s sourceAmount=%s destination=%s',
      sourceAccount, amount, destination
    )

    if (destination.length < 1) {
      throw new InvalidPacketError('missing destination.')
    }

    const route = this.routingTable.resolve(destination)

    if (!route) {
      log.info('could not find route for transfer. sourceAccount=%s sourceAmount=%s destinationAccount=%s', sourceAccount, amount, destination)
      throw new UnreachableError('no route found. source=' + sourceAccount + ' destination=' + destination)
    }

    const nextHop = route.nextHop

    log.debug('determined next hop. nextHop=%s', nextHop)

    const rate = await this.backend.getRate(sourceAccount, nextHop)

    log.debug('determined local rate. rate=%s', rate)

    this._verifyPluginIsConnected(nextHop)

    const nextAmount = new BigNumber(amount).times(rate).floor()

    return {
      nextHop,
      nextHopPacket: {
        amount: nextAmount.toString(),
        expiresAt: this._getDestinationExpiry(expiresAt),
        executionCondition,
        destination,
        data
      }
    }
  }

  // TODO: include the expiry duration in the quote logic
  _validateHoldDurations (sourceHoldDuration: number, destinationHoldDuration: number) {
    // Check destination_expiry_duration
    if (destinationHoldDuration > this.config.maxHoldTime) {
      throw new UnacceptableExpiryError('destination expiry duration ' +
        'is too long. destinationHoldDuration=' + destinationHoldDuration +
        ' maxHoldTime=' + this.config.maxHoldTime)
    }

    // Check difference between destination_expiry_duration and source_expiry_duration
    if (sourceHoldDuration - destinationHoldDuration < this.config.minMessageWindow) {
      throw new UnacceptableExpiryError('the difference between the ' +
        'destination expiry duration and the source expiry duration ' +
        'is insufficient to ensure that we can execute the ' +
        'source transfers.')
    }
  }

  _getDestinationExpiry (sourceExpiry: Date) {
    if (!sourceExpiry) {
      throw new TypeError('source expiry must be a Date')
    }
    const sourceExpiryTime = sourceExpiry.getTime()

    if (sourceExpiryTime < Date.now()) {
      throw new InsufficientTimeoutError('source transfer has already expired. sourceExpiry=' + sourceExpiry.toISOString() + ' currentTime=' + (new Date().toISOString()))
    }

    // We will set the next transfer's expiry based on the source expiry and our
    // minMessageWindow, but cap it at our maxHoldTime.
    const destinationExpiryTime = Math.min(sourceExpiryTime - this.config.minMessageWindow, Date.now() + this.config.maxHoldTime)

    if ((destinationExpiryTime - Date.now()) < this.config.minMessageWindow) {
      throw new InsufficientTimeoutError('source transfer expires too soon to complete payment. actualSourceExpiry=' + sourceExpiry.toISOString() + ' requiredSourceExpiry=' + (new Date(Date.now() + 2 * this.config.minMessageWindow).toISOString()) + ' currentTime=' + (new Date().toISOString()))
    }

    return new Date(destinationExpiryTime)
  }

  _verifyPluginIsConnected (account: string) {
    if (!this.accounts.getPlugin(account).isConnected()) {
      throw new LedgerNotConnectedError('no connection to account. account=' + account)
    }
  }
}
