/* eslint max-nested-callbacks: ["error", 6] */
/* eslint-env mocha */
'use strict'

const hat = require('hat')
const chai = require('chai')
const dirtyChai = require('dirty-chai')
const expect = chai.expect
chai.use(dirtyChai)

const base64url = require('base64url')
const { fromB58String } = require('multihashes')
const retry = require('async/retry')
const series = require('async/series')
const callbackify = require('callbackify')
const peerId = require('peer-id')
const isNode = require('detect-node')
const ipns = require('ipns')
const IPFS = require('../../src')
const waitFor = require('../utils/wait-for')
const delay = require('interface-ipfs-core/src/utils/delay')

const DaemonFactory = require('ipfsd-ctl')
const df = DaemonFactory.create({
  type: 'proc',
  IpfsClient: require('ipfs-http-client')
})

const namespace = '/record/'
const ipfsRef = '/ipfs/QmPFVLPmp9zv5Z5KUqLhe2EivAGccQW2r7M7jhVJGLZoZU'

describe('name-pubsub', function () {
  if (!isNode) {
    return
  }

  let nodes
  let nodeA
  let nodeB
  let idA
  let idB

  const createNode = () => df.spawn({
    exec: IPFS,
    args: [`--pass ${hat()}`, '--enable-namesys-pubsub'],
    config: {
      Bootstrap: [],
      Discovery: {
        MDNS: {
          Enabled: false
        },
        webRTCStar: {
          Enabled: false
        }
      }
    },
    preload: { enabled: false }
  })

  before(async function () {
    this.timeout(40 * 1000)

    nodes = await Promise.all([
      createNode(),
      createNode()
    ])

    nodeA = nodes[0].api
    nodeB = nodes[1].api

    const ids = await Promise.all([
      nodeA.id(),
      nodeB.id()
    ])

    idA = ids[0]
    idB = ids[1]

    await nodeA.swarm.connect(idB.addresses[0])
  })

  after(() => Promise.all(nodes.map((node) => node.stop())))

  it('should publish and then resolve correctly', function (done) {
    this.timeout(80 * 1000)

    let subscribed = false

    function checkMessage (msg) {
      subscribed = true
    }

    const alreadySubscribed = (cb) => {
      return cb(null, subscribed === true)
    }

    // Wait until a peer subscribes a topic
    const waitForPeerToSubscribe = (node, topic, callback) => {
      retry({
        times: 5,
        interval: 2000
      }, (next) => {
        node.pubsub.peers(topic, (error, res) => {
          if (error) {
            return next(error)
          }

          if (!res || !res.length) {
            return next(new Error(`Could not find subscription for topic ${topic}`))
          }

          return next(null, res)
        })
      }, callback)
    }

    const keys = ipns.getIdKeys(fromB58String(idA.id))
    const topic = `${namespace}${base64url.encode(keys.routingKey.toBuffer())}`

    nodeB.name.resolve(idA.id, (err) => {
      expect(err).to.exist()

      series([
        (cb) => waitForPeerToSubscribe(nodeA, topic, cb),
        (cb) => nodeB.pubsub.subscribe(topic, checkMessage, cb),
        (cb) => nodeA.name.publish(ipfsRef, { resolve: false }, cb),
        (cb) => waitFor((callback) => alreadySubscribed(callback), cb),
        (cb) => setTimeout(() => cb(), 1000), // guarantee record is written
        (cb) => nodeB.name.resolve(idA.id, cb)
      ], (err, res) => {
        expect(err).to.not.exist()
        expect(res).to.exist()

        expect(res[5]).to.equal(ipfsRef)
        done()
      })
    })
  })

  it('should self resolve, publish and then resolve correctly', async function () {
    this.timeout(6000)
    const emptyDirCid = '/ipfs/QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn'
    const [{ path }] = await nodeA.add(Buffer.from('pubsub records'))

    const resolvesEmpty = await nodeB.name.resolve(idB.id)
    expect(resolvesEmpty).to.be.eq(emptyDirCid)

    try {
      await nodeA.name.resolve(idB.id)
    } catch (error) {
      expect(error).to.exist()
    }

    const publish = await nodeB.name.publish(path)
    expect(publish).to.be.eql({
      name: idB.id,
      value: `/ipfs/${path}`
    })

    const resolveB = await nodeB.name.resolve(idB.id)
    expect(resolveB).to.be.eq(`/ipfs/${path}`)
    await delay(5000)
    const resolveA = await nodeA.name.resolve(idB.id)
    expect(resolveA).to.be.eq(`/ipfs/${path}`)
  })

  it('should handle event on publish correctly', function (done) {
    this.timeout(80 * 1000)

    const testAccountName = 'test-account'

    let publishedMessage = null
    let publishedMessageData = null
    let publishedMessageDataValue = null

    function checkMessage (msg) {
      publishedMessage = msg
      publishedMessageData = ipns.unmarshal(msg.data)
      publishedMessageDataValue = publishedMessageData.value.toString('utf8')
    }

    const alreadySubscribed = (cb) => {
      return cb(null, publishedMessage !== null)
    }

    // Create account for publish
    nodeA.key.gen(testAccountName, {
      type: 'rsa',
      size: 2048
    }, (err, testAccount) => {
      expect(err).to.not.exist()

      const keys = ipns.getIdKeys(fromB58String(testAccount.id))
      const topic = `${namespace}${base64url.encode(keys.routingKey.toBuffer())}`

      series([
        (cb) => nodeB.pubsub.subscribe(topic, checkMessage, cb),
        (cb) => nodeA.name.publish(ipfsRef, { resolve: false, key: testAccountName }, cb),
        (cb) => waitFor((callback) => alreadySubscribed(callback), cb),
        (cb) => peerId.createFromPubKey(publishedMessage.key, cb),
        (cb) => peerId.createFromPubKey(publishedMessageData.pubKey, cb)
      ], (err, res) => {
        expect(err).to.not.exist()
        expect(res).to.exist()

        const messageKey = res[3]
        const pubKeyPeerId = res[4]

        expect(pubKeyPeerId.toB58String()).not.to.equal(messageKey.toB58String())
        expect(pubKeyPeerId.toB58String()).to.equal(testAccount.id)
        expect(publishedMessage.from).to.equal(idA.id)
        expect(messageKey.toB58String()).to.equal(idA.id)
        expect(publishedMessageDataValue).to.equal(ipfsRef)

        // Verify the signature
        callbackify(ipns.validate.bind(ipns))(pubKeyPeerId._pubKey, publishedMessageData, (err) => {
          expect(err).to.not.exist()
          done()
        })
      })
    })
  })
})
