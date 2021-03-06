/**
 * @module converse-disco
 * @copyright The Converse.js contributors
 * @license Mozilla Public License (MPLv2)
 * @description Converse plugin which add support for XEP-0030: Service Discovery
 */
import log from "./log";
import sizzle from "sizzle";
import { Collection } from "skeletor.js/src/collection";
import { Model } from 'skeletor.js/src/model.js';
import { _converse, api, converse } from "./converse-core";
import { isEmpty, isObject } from "lodash";

const { Strophe, $iq, utils } = converse.env;

converse.plugins.add('converse-disco', {

    initialize () {
        /* The initialize function gets called as soon as the plugin is
         * loaded by converse.js's plugin machinery.
         */

        // Promises exposed by this plugin
        api.promises.add('discoInitialized');
        api.promises.add('streamFeaturesAdded');


        /**
         * @class
         * @namespace _converse.DiscoEntity
         * @memberOf _converse
         */
        _converse.DiscoEntity = Model.extend({
            /* A Disco Entity is a JID addressable entity that can be queried
             * for features.
             *
             * See XEP-0030: https://xmpp.org/extensions/xep-0030.html
             */
            idAttribute: 'jid',

            initialize (attrs, options) {
                this.waitUntilFeaturesDiscovered = utils.getResolveablePromise();

                this.dataforms = new Collection();
                let id = `converse.dataforms-${this.get('jid')}`;
                this.dataforms.browserStorage = _converse.createStore(id, 'session');

                this.features = new Collection();
                id = `converse.features-${this.get('jid')}`;
                this.features.browserStorage = _converse.createStore(id, 'session');
                this.listenTo(this.features, 'add', this.onFeatureAdded)

                this.fields = new Collection();
                id = `converse.fields-${this.get('jid')}`;
                this.fields.browserStorage = _converse.createStore(id, 'session');
                this.listenTo(this.fields, 'add', this.onFieldAdded)

                this.identities = new Collection();
                id = `converse.identities-${this.get('jid')}`;
                this.identities.browserStorage = _converse.createStore(id, 'session');
                this.fetchFeatures(options);

                this.items = new _converse.DiscoEntities();
                id = `converse.disco-items-${this.get('jid')}`;
                this.items.browserStorage = _converse.createStore(id, 'session');
                this.items.fetch();
            },

            /**
             * Returns a Promise which resolves with a map indicating
             * whether a given identity is provided by this entity.
             * @private
             * @method _converse.DiscoEntity#getIdentity
             * @param { String } category - The identity category
             * @param { String } type - The identity type
             */
            async getIdentity (category, type) {
                await this.waitUntilFeaturesDiscovered;
                return this.identities.findWhere({
                    'category': category,
                    'type': type
                });
            },

            /**
             * Returns a Promise which resolves with a map indicating
             * whether a given feature is supported.
             * @private
             * @method _converse.DiscoEntity#hasFeature
             * @param { String } feature - The feature that might be supported.
             */
            async hasFeature (feature) {
                await this.waitUntilFeaturesDiscovered
                if (this.features.findWhere({'var': feature})) {
                    return this;
                }
            },

            onFeatureAdded (feature) {
                feature.entity = this;
                /**
                 * Triggered when Converse has learned of a service provided by the XMPP server.
                 * See XEP-0030.
                 * @event _converse#serviceDiscovered
                 * @type { Model }
                 * @example _converse.api.listen.on('featuresDiscovered', feature => { ... });
                 */
                api.trigger('serviceDiscovered', feature);
            },

            onFieldAdded (field) {
                field.entity = this;
                /**
                 * Triggered when Converse has learned of a disco extension field.
                 * See XEP-0030.
                 * @event _converse#discoExtensionFieldDiscovered
                 * @example _converse.api.listen.on('discoExtensionFieldDiscovered', () => { ... });
                 */
                api.trigger('discoExtensionFieldDiscovered', field);
            },

            async fetchFeatures (options) {
                if (options.ignore_cache) {
                    this.queryInfo();
                } else {
                    const store_id = this.features.browserStorage.name;
                    const result = await this.features.browserStorage.store.getItem(store_id);
                    if (result && result.length === 0 || result === null) {
                        this.queryInfo();
                    } else {
                        this.features.fetch({
                            add: true,
                            success: () => {
                                this.waitUntilFeaturesDiscovered.resolve(this);
                                this.trigger('featuresDiscovered');
                            }
                        });
                        this.identities.fetch({add: true});
                    }
                }
            },

            async queryInfo () {
                let stanza;
                try {
                    stanza = await api.disco.info(this.get('jid'), null);
                } catch (iq) {
                    iq === null ? log.error(`Timeout for disco#info query for ${this.get('jid')}`) : log.error(iq);
                    this.waitUntilFeaturesDiscovered.resolve(this);
                    return;
                }
                this.onInfo(stanza);
            },

            onDiscoItems (stanza) {
                sizzle(`query[xmlns="${Strophe.NS.DISCO_ITEMS}"] item`, stanza).forEach(item => {
                    if (item.getAttribute("node")) {
                        // XXX: Ignore nodes for now.
                        // See: https://xmpp.org/extensions/xep-0030.html#items-nodes
                        return;
                    }
                    const jid = item.getAttribute('jid');
                    if (this.items.get(jid) === undefined) {
                        const entity = _converse.disco_entities.get(jid);
                        if (entity) {
                            this.items.add(entity);
                        } else {
                            this.items.create({'jid': jid});
                        }
                    }
                });
            },

            async queryForItems () {
                if (isEmpty(this.identities.where({'category': 'server'}))) {
                    // Don't fetch features and items if this is not a
                    // server or a conference component.
                    return;
                }
                const stanza = await api.disco.items(this.get('jid'));
                this.onDiscoItems(stanza);
            },

            onInfo (stanza) {
                Array.from(stanza.querySelectorAll('identity')).forEach(identity => {
                    this.identities.create({
                        'category': identity.getAttribute('category'),
                        'type': identity.getAttribute('type'),
                        'name': identity.getAttribute('name')
                    });
                });

                sizzle(`x[type="result"][xmlns="${Strophe.NS.XFORM}"]`, stanza).forEach(form => {
                    const data = {};
                    sizzle('field', form).forEach(field => {
                        data[field.getAttribute('var')] = {
                            'value': field.querySelector('value')?.textContent,
                            'type': field.getAttribute('type')
                        };
                    });
                    this.dataforms.create(data);
                });

                if (stanza.querySelector(`feature[var="${Strophe.NS.DISCO_ITEMS}"]`)) {
                    this.queryForItems();
                }
                Array.from(stanza.querySelectorAll('feature')).forEach(feature => {
                    this.features.create({
                        'var': feature.getAttribute('var'),
                        'from': stanza.getAttribute('from')
                    });
                });

                // XEP-0128 Service Discovery Extensions
                sizzle('x[type="result"][xmlns="jabber:x:data"] field', stanza).forEach(field => {
                    this.fields.create({
                        'var': field.getAttribute('var'),
                        'value': field.querySelector('value')?.textContent,
                        'from': stanza.getAttribute('from')
                    });
                });

                this.waitUntilFeaturesDiscovered.resolve(this);
                this.trigger('featuresDiscovered');
            }
        });

        _converse.DiscoEntities = Collection.extend({
            model: _converse.DiscoEntity,

            fetchEntities () {
                return new Promise((resolve, reject) => {
                    this.fetch({
                        add: true,
                        success: resolve,
                        error (m, e) {
                            log.error(e);
                            reject (new Error("Could not fetch disco entities"));
                        }
                    });
                });
            }
        });


        function addClientFeatures () {
            // See https://xmpp.org/registrar/disco-categories.html
            api.disco.own.identities.add('client', 'web', 'Converse');

            api.disco.own.features.add(Strophe.NS.CHATSTATES);
            api.disco.own.features.add(Strophe.NS.DISCO_INFO);
            api.disco.own.features.add(Strophe.NS.ROSTERX); // Limited support
            if (api.settings.get("message_carbons")) {
                api.disco.own.features.add(Strophe.NS.CARBONS);
            }
            /**
             * Triggered in converse-disco once the core disco features of
             * Converse have been added.
             * @event _converse#addClientFeatures
             * @example _converse.api.listen.on('addClientFeatures', () => { ... });
             */
            api.trigger('addClientFeatures');
            return this;
        }


        function initStreamFeatures () {
            // Initialize the stream_features collection, and if we're
            // re-attaching to a pre-existing BOSH session, we restore the
            // features from cache.
            // Otherwise the features will be created once we've received them
            // from the server (see populateStreamFeatures).
            if (!_converse.stream_features) {
                const bare_jid = Strophe.getBareJidFromJid(_converse.jid);
                const id = `converse.stream-features-${bare_jid}`;
                api.promises.add('streamFeaturesAdded');
                _converse.stream_features = new Collection();
                _converse.stream_features.browserStorage = _converse.createStore(id, "session");
            }
        }


        function populateStreamFeatures () {
            // Strophe.js sets the <stream:features> element on the
            // Strophe.Connection instance (_converse.connection).
            //
            // Once this is done, we populate the _converse.stream_features collection
            // and trigger streamFeaturesAdded.
            initStreamFeatures();
            Array.from(_converse.connection.features.childNodes).forEach(feature => {
                _converse.stream_features.create({
                    'name': feature.nodeName,
                    'xmlns': feature.getAttribute('xmlns')
                });
            });
            notifyStreamFeaturesAdded();
        }


        function notifyStreamFeaturesAdded () {
            /**
             * Triggered as soon as the stream features are known.
             * If you want to check whether a stream feature is supported before proceeding,
             * then you'll first want to wait for this event.
             * @event _converse#streamFeaturesAdded
             * @example _converse.api.listen.on('streamFeaturesAdded', () => { ... });
             */
            api.trigger('streamFeaturesAdded');
        }


        const plugin = this;
        plugin._identities = [];
        plugin._features = [];

        function onDiscoInfoRequest (stanza) {
            const node = stanza.getElementsByTagName('query')[0].getAttribute('node');
            const attrs = {xmlns: Strophe.NS.DISCO_INFO};
            if (node) { attrs.node = node; }

            const iqresult = $iq({'type': 'result', 'id': stanza.getAttribute('id')});
            const from = stanza.getAttribute('from');
            if (from !== null) {
                iqresult.attrs({'to': from});
            }
            iqresult.c('query', attrs);
            plugin._identities.forEach(identity => {
                const attrs = {
                    'category': identity.category,
                    'type': identity.type
                };
                if (identity.name) {
                    attrs.name = identity.name;
                }
                if (identity.lang) {
                    attrs['xml:lang'] = identity.lang;
                }
                iqresult.c('identity', attrs).up();
            });
            plugin._features.forEach(feature => iqresult.c('feature', {'var': feature}).up());
            api.send(iqresult.tree());
            return true;
        }


        async function initializeDisco () {
            addClientFeatures();
            _converse.connection.addHandler(onDiscoInfoRequest, Strophe.NS.DISCO_INFO, 'iq', 'get', null, null);

            _converse.disco_entities = new _converse.DiscoEntities();
            const id = `converse.disco-entities-${_converse.bare_jid}`;
            _converse.disco_entities.browserStorage = _converse.createStore(id, 'session');
            const collection = await _converse.disco_entities.fetchEntities();
            if (collection.length === 0 || !collection.get(_converse.domain)) {
                // If we don't have an entity for our own XMPP server,
                // create one.
                _converse.disco_entities.create({'jid': _converse.domain});
            }
            /**
             * Triggered once the `converse-disco` plugin has been initialized and the
             * `_converse.disco_entities` collection will be available and populated with at
             * least the service discovery features of the user's own server.
             * @event _converse#discoInitialized
             * @example _converse.api.listen.on('discoInitialized', () => { ... });
             */
            api.trigger('discoInitialized');
        }

        /******************** Event Handlers ********************/

        api.listen.on('userSessionInitialized', async () => {
            initStreamFeatures();
            if (_converse.connfeedback.get('connection_status') === Strophe.Status.ATTACHED) {
                // When re-attaching to a BOSH session, we fetch the stream features from the cache.
                await new Promise((success, error) => _converse.stream_features.fetch({ success, error }));
                notifyStreamFeaturesAdded();
            }
        });
        api.listen.on('beforeResourceBinding', populateStreamFeatures);

        api.listen.on('reconnected', initializeDisco);
        api.listen.on('connected', initializeDisco);

        api.listen.on('beforeTearDown', async () => {
            api.promises.add('streamFeaturesAdded')
            if (_converse.stream_features) {
                await _converse.stream_features.clearStore();
                delete _converse.stream_features;
            }
        });

        api.listen.on('clearSession', () => {
            if (_converse.shouldClearCache() && _converse.disco_entities) {
                Array.from(_converse.disco_entities.models).forEach(e => e.features.clearStore());
                Array.from(_converse.disco_entities.models).forEach(e => e.identities.clearStore());
                Array.from(_converse.disco_entities.models).forEach(e => e.dataforms.clearStore());
                Array.from(_converse.disco_entities.models).forEach(e => e.fields.clearStore());
                _converse.disco_entities.clearStore();
                delete _converse.disco_entities;
            }
        });


        /************************ API ************************/

        Object.assign(api, {
            /**
             * The XEP-0030 service discovery API
             *
             * This API lets you discover information about entities on the
             * XMPP network.
             *
             * @namespace api.disco
             * @memberOf api
             */
            disco: {
                /**
                 * @namespace api.disco.stream
                 * @memberOf api.disco
                 */
                stream: {
                    /**
                     * @method api.disco.stream.getFeature
                     * @param {String} name The feature name
                     * @param {String} xmlns The XML namespace
                     * @example _converse.api.disco.stream.getFeature('ver', 'urn:xmpp:features:rosterver')
                     */
                    async getFeature (name, xmlns) {
                        await api.waitUntil('streamFeaturesAdded');
                        if (!name || !xmlns) {
                            throw new Error("name and xmlns need to be provided when calling disco.stream.getFeature");
                        }
                        if (_converse.stream_features === undefined && !api.connection.connected()) {
                            // Happens during tests when disco lookups happen asynchronously after teardown.
                            const msg = `Tried to get feature ${name} ${xmlns} but _converse.stream_features has been torn down`;
                            log.warn(msg);
                            return;
                        }
                        return _converse.stream_features.findWhere({'name': name, 'xmlns': xmlns});
                    }
                },

                /**
                 * @namespace api.disco.own
                 * @memberOf api.disco
                 */
                own: {
                    /**
                     * @namespace api.disco.own.identities
                     * @memberOf api.disco.own
                     */
                    identities: {
                        /**
                         * Lets you add new identities for this client (i.e. instance of Converse)
                         * @method api.disco.own.identities.add
                         *
                         * @param {String} category - server, client, gateway, directory, etc.
                         * @param {String} type - phone, pc, web, etc.
                         * @param {String} name - "Converse"
                         * @param {String} lang - en, el, de, etc.
                         *
                         * @example _converse.api.disco.own.identities.clear();
                         */
                        add (category, type, name, lang) {
                            for (var i=0; i<plugin._identities.length; i++) {
                                if (plugin._identities[i].category == category &&
                                    plugin._identities[i].type == type &&
                                    plugin._identities[i].name == name &&
                                    plugin._identities[i].lang == lang) {
                                    return false;
                                }
                            }
                            plugin._identities.push({category: category, type: type, name: name, lang: lang});
                        },
                        /**
                         * Clears all previously registered identities.
                         * @method api.disco.own.identities.clear
                         * @example _converse.api.disco.own.identities.clear();
                         */
                        clear () {
                            plugin._identities = []
                        },
                        /**
                         * Returns all of the identities registered for this client
                         * (i.e. instance of Converse).
                         * @method api.disco.identities.get
                         * @example const identities = api.disco.own.identities.get();
                         */
                        get () {
                            return plugin._identities;
                        }
                    },

                    /**
                     * @namespace api.disco.own.features
                     * @memberOf api.disco.own
                     */
                    features: {
                        /**
                         * Lets you register new disco features for this client (i.e. instance of Converse)
                         * @method api.disco.own.features.add
                         * @param {String} name - e.g. http://jabber.org/protocol/caps
                         * @example _converse.api.disco.own.features.add("http://jabber.org/protocol/caps");
                         */
                        add (name) {
                            for (var i=0; i<plugin._features.length; i++) {
                                if (plugin._features[i] == name) { return false; }
                            }
                            plugin._features.push(name);
                        },
                        /**
                         * Clears all previously registered features.
                         * @method api.disco.own.features.clear
                         * @example _converse.api.disco.own.features.clear();
                         */
                        clear () {
                            plugin._features = []
                        },
                        /**
                         * Returns all of the features registered for this client (i.e. instance of Converse).
                         * @method api.disco.own.features.get
                         * @example const features = api.disco.own.features.get();
                         */
                        get () {
                            return plugin._features;
                        }
                    }
                },

                /**
                 * Query for information about an XMPP entity
                 *
                 * @method api.disco.info
                 * @param {string} jid The Jabber ID of the entity to query
                 * @param {string} [node] A specific node identifier associated with the JID
                 * @returns {promise} Promise which resolves once we have a result from the server.
                 */
                info (jid, node) {
                    const attrs = {xmlns: Strophe.NS.DISCO_INFO};
                    if (node) {
                        attrs.node = node;
                    }
                    const info = $iq({
                        'from': _converse.connection.jid,
                        'to':jid,
                        'type':'get'
                    }).c('query', attrs);
                    return api.sendIQ(info);
                },

                /**
                 * Query for items associated with an XMPP entity
                 *
                 * @method api.disco.items
                 * @param {string} jid The Jabber ID of the entity to query for items
                 * @param {string} [node] A specific node identifier associated with the JID
                 * @returns {promise} Promise which resolves once we have a result from the server.
                 */
                items (jid, node) {
                    const attrs = {'xmlns': Strophe.NS.DISCO_ITEMS};
                    if (node) {
                        attrs.node = node;
                    }
                    return api.sendIQ(
                        $iq({
                            'from': _converse.connection.jid,
                            'to':jid,
                            'type':'get'
                        }).c('query', attrs)
                    );
                },

                /**
                 * Namespace for methods associated with disco entities
                 *
                 * @namespace api.disco.entities
                 * @memberOf api.disco
                 */
                entities: {
                    /**
                     * Get the corresponding `DiscoEntity` instance.
                     *
                     * @method api.disco.entities.get
                     * @param {string} jid The Jabber ID of the entity
                     * @param {boolean} [create] Whether the entity should be created if it doesn't exist.
                     * @example _converse.api.disco.entities.get(jid);
                     */
                    async get (jid, create=false) {
                        await api.waitUntil('discoInitialized');
                        if (!jid) {
                            return _converse.disco_entities;
                        }
                        if (_converse.disco_entities === undefined && !api.connection.connected()) {
                            // Happens during tests when disco lookups happen asynchronously after teardown.
                            const msg = `Tried to look up entity ${jid} but _converse.disco_entities has been torn down`;
                            log.warn(msg);
                            return;
                        }
                        const entity = _converse.disco_entities.get(jid);
                        if (entity || !create) {
                            return entity;
                        }
                        return api.disco.entities.create(jid);
                    },

                    /**
                     * Create a new disco entity. It's identity and features
                     * will automatically be fetched from cache or from the
                     * XMPP server.
                     *
                     * Fetching from cache can be disabled by passing in
                     * `ignore_cache: true` in the options parameter.
                     *
                     * @method api.disco.entities.create
                     * @param {string} jid The Jabber ID of the entity
                     * @param {object} [options] Additional options
                     * @param {boolean} [options.ignore_cache]
                     *     If true, fetch all features from the XMPP server instead of restoring them from cache
                     * @example _converse.api.disco.entities.create(jid, {'ignore_cache': true});
                     */
                    create (jid, options) {
                        return _converse.disco_entities.create({'jid': jid}, options);
                    }
                },

                /**
                 * @namespace api.disco.features
                 * @memberOf api.disco
                 */
                features: {
                    /**
                     * Return a given feature of a disco entity
                     *
                     * @method api.disco.features.get
                     * @param {string} feature The feature that might be
                     *     supported. In the XML stanza, this is the `var`
                     *     attribute of the `<feature>` element. For
                     *     example: `http://jabber.org/protocol/muc`
                     * @param {string} jid The JID of the entity
                     *     (and its associated items) which should be queried
                     * @returns {promise} A promise which resolves with a list containing
                     *     _converse.Entity instances representing the entity
                     *     itself or those items associated with the entity if
                     *     they support the given feature.
                     * @example
                     * api.disco.features.get(Strophe.NS.MAM, _converse.bare_jid);
                     */
                    async get (feature, jid) {
                        if (!jid) {
                            throw new TypeError('You need to provide an entity JID');
                        }
                        await api.waitUntil('discoInitialized');
                        let entity = await api.disco.entities.get(jid, true);

                        if (_converse.disco_entities === undefined && !api.connection.connected()) {
                            // Happens during tests when disco lookups happen asynchronously after teardown.
                            const msg = `Tried to get feature ${feature} for ${jid} but _converse.disco_entities has been torn down`;
                            log.warn(msg);
                            return;
                        }
                        entity = await entity.waitUntilFeaturesDiscovered;
                        const promises = [...entity.items.map(i => i.hasFeature(feature)), entity.hasFeature(feature)];
                        const result = await Promise.all(promises);
                        return result.filter(isObject);
                    }
                },

                /**
                 * Used to determine whether an entity supports a given feature.
                 *
                 * @method api.disco.supports
                 * @param {string} feature The feature that might be
                 *     supported. In the XML stanza, this is the `var`
                 *     attribute of the `<feature>` element. For
                 *     example: `http://jabber.org/protocol/muc`
                 * @param {string} jid The JID of the entity
                 *     (and its associated items) which should be queried
                 * @returns {promise} A promise which resolves with `true` or `false`.
                 * @example
                 * if (await api.disco.supports(Strophe.NS.MAM, _converse.bare_jid)) {
                 *     // The feature is supported
                 * } else {
                 *     // The feature is not supported
                 * }
                 */
                async supports (feature, jid) {
                    const features = await api.disco.features.get(feature, jid);
                    return features.length > 0;
                },

                /**
                 * Refresh the features, fields and identities associated with a
                 * disco entity by refetching them from the server
                 * @method api.disco.refresh
                 * @param {string} jid The JID of the entity whose features are refreshed.
                 * @returns {promise} A promise which resolves once the features have been refreshed
                 * @example
                 * await api.disco.refresh('room@conference.example.org');
                 */
                async refresh (jid) {
                    if (!jid) {
                        throw new TypeError('api.disco.refresh: You need to provide an entity JID');
                    }
                    await api.waitUntil('discoInitialized');
                    let entity = await api.disco.entities.get(jid);
                    if (entity) {
                        entity.features.reset();
                        entity.fields.reset();
                        entity.identities.reset();
                        if (!entity.waitUntilFeaturesDiscovered.isPending) {
                            entity.waitUntilFeaturesDiscovered = utils.getResolveablePromise()
                        }
                        entity.queryInfo();
                    } else {
                        // Create it if it doesn't exist
                        entity = await api.disco.entities.create(jid, {'ignore_cache': true});
                    }
                    return entity.waitUntilFeaturesDiscovered;
                },

                /**
                 * @deprecated Use {@link api.disco.refresh} instead.
                 * @method api.disco.refreshFeatures
                 */
                refreshFeatures (jid) {
                    return api.refresh(jid);
                },

                /**
                 * Return all the features associated with a disco entity
                 *
                 * @method api.disco.getFeatures
                 * @param {string} jid The JID of the entity whose features are returned.
                 * @returns {promise} A promise which resolves with the returned features
                 * @example
                 * const features = await api.disco.getFeatures('room@conference.example.org');
                 */
                async getFeatures (jid) {
                    if (!jid) {
                        throw new TypeError('api.disco.getFeatures: You need to provide an entity JID');
                    }
                    await api.waitUntil('discoInitialized');
                    let entity = await api.disco.entities.get(jid, true);
                    entity = await entity.waitUntilFeaturesDiscovered;
                    return entity.features;
                },

                /**
                 * Return all the service discovery extensions fields
                 * associated with an entity.
                 *
                 * See [XEP-0129: Service Discovery Extensions](https://xmpp.org/extensions/xep-0128.html)
                 *
                 * @method api.disco.getFields
                 * @param {string} jid The JID of the entity whose fields are returned.
                 * @example
                 * const fields = await api.disco.getFields('room@conference.example.org');
                 */
                async getFields (jid) {
                    if (!jid) {
                        throw new TypeError('api.disco.getFields: You need to provide an entity JID');
                    }
                    await api.waitUntil('discoInitialized');
                    let entity = await api.disco.entities.get(jid, true);
                    entity = await entity.waitUntilFeaturesDiscovered;
                    return entity.fields;
                },

                /**
                 * Get the identity (with the given category and type) for a given disco entity.
                 *
                 * For example, when determining support for PEP (personal eventing protocol), you
                 * want to know whether the user's own JID has an identity with
                 * `category='pubsub'` and `type='pep'` as explained in this section of
                 * XEP-0163: https://xmpp.org/extensions/xep-0163.html#support
                 *
                 * @method api.disco.getIdentity
                 * @param {string} The identity category.
                 *     In the XML stanza, this is the `category`
                 *     attribute of the `<identity>` element.
                 *     For example: 'pubsub'
                 * @param {string} type The identity type.
                 *     In the XML stanza, this is the `type`
                 *     attribute of the `<identity>` element.
                 *     For example: 'pep'
                 * @param {string} jid The JID of the entity which might have the identity
                 * @returns {promise} A promise which resolves with a map indicating
                 *     whether an identity with a given type is provided by the entity.
                 * @example
                 * api.disco.getIdentity('pubsub', 'pep', _converse.bare_jid).then(
                 *     function (identity) {
                 *         if (identity) {
                 *             // The entity DOES have this identity
                 *         } else {
                 *             // The entity DOES NOT have this identity
                 *         }
                 *     }
                 * ).catch(e => log.error(e));
                 */
                async getIdentity (category, type, jid) {
                    const e = await api.disco.entities.get(jid, true);
                    if (e === undefined && !api.connection.connected()) {
                        // Happens during tests when disco lookups happen asynchronously after teardown.
                        const msg = `Tried to look up category ${category} for ${jid} but _converse.disco_entities has been torn down`;
                        log.warn(msg);
                        return;
                    }
                    return e.getIdentity(category, type);
                }
            }
        });
    }
});
