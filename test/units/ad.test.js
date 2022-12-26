/**
 * @jest-environment ./test/helpers/jest-thunderbird-environment.cjs
 */

import { AutomaticDictionary } from './../../addon/ad';
import { ComposeWindowStub } from './../../addon/ad/compose_window_stub';

import { jest } from '@jest/globals'

import { mockComposeWindow } from '../helpers/ad_test_helper.js'

beforeEach(async () => {
    jest.setTimeout(1000);
    browser._flushStorage();
    AutomaticDictionary.instances = [];

    // Mock CurrentTimestamp
    var last_timestamp = Date.now();
    AutomaticDictionary.Class.prototype.currentTimestamp = function(){
        // A bit more than the 1500 ms we mute any languageChanged event.
        last_timestamp = last_timestamp + 1501;
        return last_timestamp;
    }
})

test('Initial boot', (done) => {
    /**
     * Just check that it can boot from empty data.
    */
    var ad = new AutomaticDictionary.Class({
        window: window,
        compose_window_builder: ComposeWindowStub,
        logLevel: 'error',
        deduceOnLoad: false
    }, async (ad) => {
        let lruHash = await ad.languageAssigner.lruHash._object();
        expect(lruHash.max_size).toBe(1200)

        done();
    });
});

test('All instances share the same data objects', (done) => {
    var ad = new AutomaticDictionary.Class({
        window: window,
        compose_window_builder: ComposeWindowStub,
        logLevel: 'error',
        deduceOnLoad: false
    }, async (ad) => {
        var other_ad = new AutomaticDictionary.Class({
            window: window,
            compose_window_builder: ComposeWindowStub,
            logLevel: 'error',
            deduceOnLoad: false
        }, async (other_ad) => {
            ad.languageAssigner._test_marker = Math.random();
            ad.domainHeuristic._test_marker = Math.random();

            expect(ad.languageAssigner).toStrictEqual(other_ad.languageAssigner)
            expect(ad.domainHeuristic).toStrictEqual(other_ad.domainHeuristic)

            done()
        });
    });
});

test('Shutdown shuts down existing instances', (done) => {
    var ad = new AutomaticDictionary.Class({
        window: window,
        compose_window_builder: ComposeWindowStub,
        logLevel: 'error',
        deduceOnLoad: false
    }, async (ad) => {
        ad.dispatchEvent = jest.fn();
        AutomaticDictionary.shutdown();
        expect(ad.dispatchEvent).toHaveBeenCalledWith({ type: 'shutdown' })
        done()
    });
});

test('On removing window we call shutdown', (done) => {
    var ad = new AutomaticDictionary.Class({
        window: window,
        compose_window_builder: ComposeWindowStub,
        logLevel: 'error',
        deduceOnLoad: false
    }, async (ad) => {
        ad.dispatchEvent = jest.fn();
        // Different window id will be discarded.
        browser.windows.onRemoved.getListeners().forEach(listener => {
            listener(42)
        });
        expect(ad.dispatchEvent).toHaveBeenCalledTimes(0);

        // Same window id
        browser.windows.onRemoved.getListeners().forEach(listener => {
            listener(window.id)
        });
        expect(ad.dispatchEvent).toHaveBeenCalledWith({ type: 'shutdown' })
        done()
    });
});

test('Internal methods?', (done) => {
    /**
        Cases:
         1. Initial boot. We have empty hash, we set a recipient in the "TO", and set a lang.
            Check that deduceLanguage deduces the one we saved earlier.
    */
    new AutomaticDictionary.Class({
        window: window,
        compose_window_builder: ComposeWindowStub,
        logLevel: 'error',
        deduceOnLoad: false
    }, async (ad) => {
        let compose_window = ad.compose_window;

        let status = { recipients: { "to": ["foo"], "cc": [] }, langs: [] }
        mockComposeWindow(compose_window, status)

        expect(ad.canSpellCheck()).resolves.toBe(true)
        expect(ad.compose_window.canSpellCheck()).resolves.toBe(true)
        await ad.deduceLanguage();

        expect(compose_window.changeLanguages).toHaveBeenCalledTimes(0);
        expect(compose_window.changeLabel).toHaveBeenCalledWith('noLangForRecipients');

        // Change the lang and trigger the event so language foolang gets associated
        // with foo.
        status.setLangs(["foolang"]);
        await ad.languageChanged();
        expect(compose_window.changeLanguages).toHaveBeenCalledTimes(0)
        expect(compose_window.changeLabel).toHaveBeenCalledTimes(2)
        expect(compose_window.changeLabel).toHaveBeenLastCalledWith('savedForRecipients')

        //Somewhere the lang is changed but you go back here and
        status.setLangs(['other']);
        await ad.deduceLanguage();

        expect(status.getLangs()).toEqual(['foolang']);

        //Set stopped.
        ad.stop();
        //Deduce language is aborted despite we change dict
        status.setLangs(["other"]);
        await ad.deduceLanguage();
        expect(status.getLangs()).toEqual(['other']);

        //When spellcheck disabled, do nothing
        ad.start();
        status.spellchecker_enabled = false;
        status.setLangs(["other"]);
        // TODO: fix this. we set count 100 to not let it delay the deduce language
        // execution 1s and being an async execution. Count 100 is greater than 10
        // so it does not postpone it.
        await ad.deduceLanguage({ count: 100 });
        expect(status.getLangs()).toEqual(['other']);

        //Enable again and everything ok.
        status.spellchecker_enabled = true;
        await ad.deduceLanguage();
        expect(status.getLangs()).toEqual(['foolang']);
        expect(compose_window.changeLabel).toHaveBeenLastCalledWith('savedForRecipients')

        //test notificationLevel error
        await ad.storage.set(ad.NOTIFICATION_LEVEL, "error");
        status.setLangs(["other"]);
        await ad.deduceLanguage();

        expect(compose_window.changeLabel).toHaveBeenCalledTimes(2);
        //Restore
        await ad.storage.set(ad.NOTIFICATION_LEVEL, "info");

        done(); return;
    });
});

/*

    2. We have an empty hash and we set a "TO" and a "CC". We set the dict,
    and check that it has been setted to the TO, to the CC alone, and the pair TO-CC.

*/
test('Tos and ccs', (done) => {
    new AutomaticDictionary.Class({
        window: window,
        compose_window_builder: ComposeWindowStub,
        logLevel: 'error',
        deduceOnLoad: false
    }, async (ad) => {
        let compose_window = ad.compose_window;

        let status = { recipients: { "to": ["foo"], "cc": ["bar"] }, langs: [] }
        mockComposeWindow(compose_window, status)

        //Change the lang and it gets stored
        status.setLangs(['foolang']);
        await ad.languageChanged();

        // Setting individuals only will assign foolang too
        status.recipients = { "to": ["foo"] };
        status.setLangs(['other']);
        await ad.deduceLanguage();
        expect(status.getLangs()).toEqual(['foolang']);

        status.recipients = { "to": ["bar"] };
        status.setLangs(['other']);
        await ad.deduceLanguage();
        expect(status.getLangs()).toEqual(['foolang']);

        done();
    })
});

test('Multiple languages support', (done) => {
    new AutomaticDictionary.Class({
        window: window,
        compose_window_builder: ComposeWindowStub,
        logLevel: 'error',
        deduceOnLoad: false
    }, async (ad) => {
        let compose_window = ad.compose_window;

        let status = { recipients: { "to": ["foo"], "cc": ["bar"] }, langs: [] }
        mockComposeWindow(compose_window, status)

        //Change the lang and it gets stored
        status.setLangs(['en', 'es']);
        await ad.languageChanged();

        // Setting individuals only will assign foolang too
        status.recipients = { "to": ["foo"] };
        status.setLangs(['other']);
        await ad.deduceLanguage();
        expect(status.getLangs()).toEqual(['en','es']);

        status.recipients = { "to": ["bar"] };
        status.setLangs(['other']);
        await ad.deduceLanguage();
        expect(status.getLangs()).toEqual(['en','es']);

        // If Thunderbird returns languages in different order, it still
        // sees it as the same languages set and does nothing.
        status.setLangs(['es', 'en']);
        const callsBefore = compose_window.changeLabel.mock.calls.length;

        await ad.languageChanged();
        expect(status.getLangs().sort()).toEqual(['en','es']);
        expect(compose_window.changeLabel).toHaveBeenCalledTimes(callsBefore);

        // If current langs are same but unsorted from the deduction, it does
        // nothing.
        await ad.deduceLanguage();
        expect(status.getLangs().sort()).toEqual(['en','es']);
        expect(compose_window.changeLabel).toHaveBeenCalledTimes(callsBefore);

        done();
    })
});

test('Language change when no recipients is discarded', (done) => {
    new AutomaticDictionary.Class({
        window: window,
        compose_window_builder: ComposeWindowStub,
        logLevel: 'error',
        deduceOnLoad: false
    }, async (ad) => {
        let compose_window = ad.compose_window;

        let status = { recipients: { "to": [], "cc": [] }, langs: ['en'] }
        mockComposeWindow(compose_window, status)
        await ad.languageChanged();

        expect(compose_window.changeLabel).not.toHaveBeenCalled();
        done();
    });
});

/*
    3. We have two TO's saved with diferent langs, we set them as the current
    recipients and check that the lang used is the one from the first recipient.

*/
test('TOs priorization', (done) => {
    new AutomaticDictionary.Class({
        window: window,
        compose_window_builder: ComposeWindowStub,
        logLevel: 'error',
        deduceOnLoad: false
    }, async (ad) => {
        let compose_window = ad.compose_window;
        // Store first the preference for each recipient
        let status = { recipients: { "to": ["catalan"] }, langs: [] }
        mockComposeWindow(compose_window, status)

        status.setLangs(['ca']);
        await ad.languageChanged();

        status.recipients = { "to": ["spanish"] };
        status.setLangs(['es']);
        await ad.languageChanged();

        // Scenario is ready

        status.recipients = { "to": ["spanish", "catalan"] };
        await ad.deduceLanguage();
        expect(status.getLangs()).toEqual(['es']);

        status.recipients = { "to": ["catalan", "spanish"] };

        await ad.deduceLanguage();
        expect(status.getLangs()).toEqual(['ca']);

        done();
    });
});

/*

    4. [Conditionals] We have already setted the "TO-A", "TO-A & CC-B" and "TO-B".
    We set the recipients to be: TO-A && CC-B to another lang. The new
    lang is saved to "TO-A & CC-B" but not to "TO-A" nor "TO-B" as they're
    already setted.
*/

test('Do not overwrite individuals language when its a group language', (done) => {
    new AutomaticDictionary.Class({
        window: window,
        compose_window_builder: ComposeWindowStub,
        logLevel: 'error',
        deduceOnLoad: false
    }, async (ad) => {
        let compose_window = ad.compose_window;

        // Store first the preference for each recipient
        let status = { recipients: {}, langs: [] }
        mockComposeWindow(compose_window, status)

        //Prepare scenario
        status.recipients = { "to": ["A"] };
        status.setLangs(["toA-lang"]);
        await ad.languageChanged();
        status.recipients = { "to": ["A"], "cc": ["B"] };
        status.setLangs(["toAccB-lang"]);
        await ad.languageChanged();
        status.recipients = { "to": ["B"] };
        status.setLangs(["toB-lang"]);
        await ad.languageChanged();

        //Scenario ready
        status.recipients = { "to": ["A"], "cc": ["B"] };
        status.setLangs(["new-toAccB-lang"]);
        await ad.languageChanged();
        //Language is setted
        await ad.deduceLanguage();
        expect(status.getLangs()).toEqual(["new-toAccB-lang"]);

        //Check it has not affected the others
        status.recipients = { "to": ["A"] };
        await ad.deduceLanguage();
        expect(status.getLangs()).toEqual(["toA-lang"]);

        status.recipients = { "to": ["B"] };
        await ad.deduceLanguage();
        expect(status.getLangs()).toEqual(["toB-lang"]);

        // Setting lang to a group does not update the ones alone
        status.recipients = { "to": ["A", "B"] };
        status.setLangs(["toA-toB-lang"]);
        await ad.languageChanged();

        status.recipients = { "to": ["A"] };
        await ad.deduceLanguage();
        expect(status.getLangs()).toEqual(["toA-lang"]);
        done(); return;
    })
});

/*
    5. Limit the max CCs or TOs management to a number to avoid loading
    the hash with useless data or too much processing of useless data.
    The max would be a configuration parameter (migrations! :) )

*/
test('Max recipients assignment', (done) => {
    new AutomaticDictionary.Class({
        window: window,
        compose_window_builder: ComposeWindowStub,
        logLevel: 'error',
        deduceOnLoad: false
    }, async (ad) => {
        let compose_window = ad.compose_window;

        // Store first the preference for each recipient
        let status = { recipients: {}, langs: [] }
        mockComposeWindow(compose_window, status)

        //Prepare scenario
        status.recipients = { "to": ["A"] };
        status.setLangs(["toA-lang"]);
        await ad.languageChanged();

        //Prepare scenario
        var current_limit = 10;
        var recipients = { "to": [] };
        for (var i = 0; i < current_limit; i++) {
            recipients.to.push("recipient" + i);
        }

        status.recipients = recipients;
        status.setLangs(["ca_es"]);
        await ad.languageChanged();

        await ad.deduceLanguage();
        expect(status.getLangs()).toEqual(['ca_es']);

        //More than maxRecipients is discarded
        recipients.to.push("toomuch");

        status.setLangs(['foobar']);
        await ad.languageChanged();
        // We do not want to update the current lang because
        // the user has manually changed the lang and do not
        // want it to be reverted.
        expect(status.getLangs()).toEqual(['foobar']);

        // When the recipients goes lower the limit
        recipients.to.pop();
        status.setLangs(['andromeda']);
        await ad.languageChanged();

        status.setLangs(['other']);
        await ad.deduceLanguage();
        expect(status.getLangs()).toEqual(["andromeda"]);
        done();
    });

});

/*

    6. We only call to changeLabel when something has changed to not bother
    the user too much.

*/
test('Minimize notifications', (done) => {
    new AutomaticDictionary.Class({
        window: window,
        compose_window_builder: ComposeWindowStub,
        logLevel: 'error',
        deduceOnLoad: false
    }, async (ad) => {
        let compose_window = ad.compose_window;

        let status = { recipients: {}, langs: [] }
        mockComposeWindow(compose_window, status)

        //Prepare scenario
        status.recipients = { "to": ["foo"], "cc": ["bar"] };

        await ad.deduceLanguage();
        expect(compose_window.changeLabel).toHaveBeenCalledTimes(1)
        expect(compose_window.changeLabel).toHaveBeenLastCalledWith('noLangForRecipients')

        await ad.deduceLanguage();
        expect(compose_window.changeLabel).toHaveBeenCalledTimes(1)

        status.recipients = { "to": ["foo"] };
        await ad.deduceLanguage();
        await ad.deduceLanguage();

        expect(compose_window.changeLabel).toHaveBeenCalledTimes(2)
        expect(compose_window.changeLabel).toHaveBeenLastCalledWith('noLangForRecipients')

        status.setLangs(['foobar']);
        await ad.languageChanged();

        expect(compose_window.changeLabel).toHaveBeenCalledTimes(3)
        expect(compose_window.changeLabel).toHaveBeenLastCalledWith('savedForRecipients')

        await ad.deduceLanguage();
        //We do not expect a new label because is the same lang as we were using
        expect(compose_window.changeLabel).toHaveBeenCalledTimes(3)

        //If it has changed it will update the lang but not notifying anybody
        //as this is what he has setted before. This happens when more than one
        //ad instance is open
        status.setLangs(['other']);
        await ad.deduceLanguage();
        expect(compose_window.changeLabel).toHaveBeenCalledTimes(3)
        expect(status.getLangs()).toEqual(['foobar']);
        done();
    });
});

test('When error on change language', (done) => {
    new AutomaticDictionary.Class({
        window: window,
        compose_window_builder: ComposeWindowStub,
        logLevel: 'fatal',
        deduceOnLoad: false
    }, async (ad) => {
        let compose_window = ad.compose_window;

        let status = { recipients: {}, langs: ['en'] }
        mockComposeWindow(compose_window, status)

        //Prepare scenario
        status.recipients = { "to": ["John"], "cc": [] };

        await ad.languageChanged();

        status.setLangs(['es']);

        // Mock 3 times raise an error
        [1, 2, 3].forEach(element => {
            compose_window.changeLanguages.mockImplementationOnce(() => {
                return new Promise(() => {
                    throw new Error("changeLanguages fake error");
                });
            })
        });
        ad.addEventListener('deduction-completed', function () {
            expect(status.getLangs()).toEqual(['en']);
            done();
        });

        await ad.deduceLanguage();
    });
});

describe('deduce language when spellchecker is not ready', () => {
    beforeEach(() => {
        jest.setTimeout(5000);
    })

    test('it retires and success', (done) => {
        new AutomaticDictionary.Class({
            window: window,
            compose_window_builder: ComposeWindowStub,
            logLevel: 'fatal',
            deduceOnLoad: false
        }, async (ad) => {
            let compose_window = ad.compose_window;

            let status = { recipients: { to: 'foo', cc: 'bar' }, langs: ['en'] }
            mockComposeWindow(compose_window, status)

            compose_window.canSpellCheck.mockResolvedValueOnce(false);

            ad.addEventListener('deduction-completed', function () {
                done();
            });

            await ad.deduceLanguage();
        });
    });

    test('after 10 retries, it stops', (done) => {
        new AutomaticDictionary.Class({
            window: window,
            compose_window_builder: ComposeWindowStub,
            logLevel: 'fatal',
            deduceOnLoad: false
        }, async (ad) => {
            let compose_window = ad.compose_window;

            let status = { recipients: { to: 'foo', cc: 'bar' }, langs: ['en'] }
            mockComposeWindow(compose_window, status)

            compose_window.canSpellCheck.mockResolvedValue(false);
            ad.addEventListener('deduction-failed', function () {
                done();
            });

            await ad.deduceLanguage();
        });
    });

})

/*
    8. Test using heuristics
*/
test('Heuristics', (done) => {
    new AutomaticDictionary.Class({
        window: window,
        compose_window_builder: ComposeWindowStub,
        logLevel: 'error',
        deduceOnLoad: false
    }, async (ad) => {
        let compose_window = ad.compose_window;
        // Overwrite max_size of data hash
        let lruHash = await ad.languageAssigner.lruHash._object();
        lruHash.max_size = 5;

        let status = { recipients: {}, langs: [] }
        mockComposeWindow(compose_window, status)

        //Prepare scenario
        status.recipients = {
            "to": ["foo"],
            "cc": ["bar"]
        };

        await ad.deduceLanguage();
        expect(compose_window.changeLabel).toHaveBeenLastCalledWith('noLangForRecipients')

        status.recipients = { "to": ["foo@bar.dom"] };
        status.setLangs(['foobar']);
        await ad.languageChanged();

        status.setLangs(['other']);
        status.recipients = { "to": ["abc@bar.dom"] };
        await ad.deduceLanguage();

        expect(status.getLangs()).toEqual(['foobar']);
        expect(compose_window.changeLabel).toHaveBeenLastCalledWith('deducedLang.guess')
        //Test it's saved
        expect(await ad.domainHeuristic.freq_suffix.pairs()).toStrictEqual(
            [["bar.dom", "foobar", 1]],
        );
        // After guessing, languageChange event should be discarded unless lang is different
        const callsToChangeLableBefore = compose_window.changeLabel.mock.calls.length;
        await ad.languageChanged();
        // Nothing done.
        expect(compose_window.changeLabel).toHaveBeenCalledTimes(callsToChangeLableBefore);
        expect(compose_window.changeLabel).toHaveBeenLastCalledWith('deducedLang.guess')

        //Check that the expired key is removed form the freq_suffix too
        status.recipients = {
            "to": ["abc2@bar2.dom", "abc2@bar3.dom", "abc2@bar4.dom", "abc2@bar5.dom"]
        };
        status.setLangs(["foobar-x"]);
        await ad.languageChanged();

        //Max size is 5 but there is a key of all TOs composed which is the fifth position
        expect(await ad.domainHeuristic.freq_suffix.pairs()).toStrictEqual(
            [
                ["bar2.dom", "foobar-x", 1],
                ["bar3.dom", "foobar-x", 1],
                ["bar4.dom", "foobar-x", 1],
                ["bar5.dom", "foobar-x", 1]
            ]
        );

        //When we change preference, unregiser from freq_suffix the old pref
        // and set the new one. In this case we change the abc2@bar2.com preference
        status.recipients = { "to": ["abc2@bar2.dom"] };
        status.setLangs(["foobar-changed"]);
        await ad.languageChanged();

        await ad.deduceLanguage();

        expect(await ad.domainHeuristic.freq_suffix.pairs()).toStrictEqual(
            [
                ["bar3.dom", "foobar-x", 1],
                ["bar4.dom", "foobar-x", 1],
                ["bar5.dom", "foobar-x", 1],
                ["bar2.dom", "foobar-changed", 1],
            ]);

        //Test its saved on storage
        expect((await browser.storage.local.get('freqTableData')).freqTableData).toStrictEqual(
            JSON.stringify(
                [
                    ["bar3.dom", "foobar-x", 1],
                    ["bar4.dom", "foobar-x", 1],
                    ["bar5.dom", "foobar-x", 1],
                    ["bar2.dom", "foobar-changed", 1],
                ]
            )
        );

        //Test that on various recipients it ponderates the language.
        status.recipients = { "to": ["abc2@bar2.dom2"] };
        status.setLangs(['dom2lang']);
        await ad.languageChanged()

        status.recipients = {
            "to": [
                "abc3@bar2.dom",
                "abc2@bar3.dom2",
                "abc2@bar4.dom2",
                "abc2@bar5.dom2"
            ]
        };

        await ad.deduceLanguage();
        expect(status.getLangs()).toEqual(["dom2lang"]);
        done();
    });

});

test('Heuristics for multiple languages', (done) => {
    new AutomaticDictionary.Class({
        window: window,
        compose_window_builder: ComposeWindowStub,
        logLevel: 'error',
        deduceOnLoad: false
    }, async (ad) => {
        let compose_window = ad.compose_window;
        let status = { recipients: {}, langs: [] }
        mockComposeWindow(compose_window, status)

        //Prepare scenario
        status.recipients = {
            "to": ["foo@example.com"],
        };
        status.setLangs(['en','es'])

        await ad.languageChanged();

        status.recipients = {
            "to": ["bar@example.com"],
        };
        status.setLangs([])

        await ad.deduceLanguage();
        expect(status.getLangs()).toEqual(['en','es']);
        expect(compose_window.changeLabel).toHaveBeenLastCalledWith('deducedLang.guess')

        done();
    });
});


/*

    9. Check when we set an unknown recipient and a known CC recipient. It should
    set/guess the lang setted for the other. The same when settting 2 TOs and one is
    known and the other not. It should use the known one.

*/

test('when only data is on CC recipients', (done) => {
    new AutomaticDictionary.Class({
        window: window,
        compose_window_builder: ComposeWindowStub,
        logLevel: 'error',
        deduceOnLoad: false
    }, async (ad) => {
        let compose_window = ad.compose_window;

        let status = { recipients: {}, langs: [] }
        mockComposeWindow(compose_window, status)

        //Prepare scenario
        status.recipients = { "to": ["a@a.com"] };
        status.setLangs(["lang-a"]);
        await ad.languageChanged();
        //Scenario ready

        status.recipients = { "to": ["a@a.com", "b@b.com"] };
        status.setLangs(['other']);
        //Language is setted
        await ad.deduceLanguage();
        expect(status.getLangs()).toEqual(['lang-a']);

        // When we have a cc recipient with known data, we can deduce it
        status.recipients = {
            "to": ["c@c.com"],
            "cc": ["a@a.com"]
        };
        status.setLangs(['other']);

        await ad.deduceLanguage();
        expect(status.getLangs()).toEqual(['lang-a']);
        done();
    })
});

test('migration to fix freq-suffix data', (done) => {
    // Setup previous freq-suffix data
    const freq_suffix_previous_data = {
        freqTableData: JSON.stringify(
            [
                ["removed-example.es", "es", -3],
                ["example.es", "es", 1],
                ["example.com", "en", 1],
                ["bad-example.es[cc]real-me.com", "es", -1],
            ]
        )
    }
    browser.storage.local.set(freq_suffix_previous_data).then(() => {
        new AutomaticDictionary.Class({
            window: window,
            compose_window_builder: ComposeWindowStub,
            logLevel: 'error',
            deduceOnLoad: false
        }, async (ad) => {
            const pairs = await ad.domainHeuristic.freq_suffix.pairs();
            expect(pairs).toStrictEqual(
                [
                    ["example.es", "es", 1],
                    ["example.com", "en", 1]
                ]
            )
            done();
        });
    })
});

test('migration to store array of languages in LRU hash', (done) => {
    // Setup previous data
    const previous_data = {
        addressesInfo: JSON.stringify(
            {
                hash: {
                    "foo@bar.com":"es",
                    "x":"en"
                },
                options:{
                    sorted_keys:["foo@bar.com","x"]
                }
            }
        )
    }
    browser.storage.local.set(previous_data).then(() => {
        new AutomaticDictionary.Class({
            window: window,
            compose_window_builder: ComposeWindowStub,
            logLevel: 'error',
            deduceOnLoad: false
        }, async (ad) => {
            const raw =  await browser.storage.local.get('addressesInfo');
            const data = JSON.parse(raw.addressesInfo);
            expect(data.hash["foo@bar.com"]).toEqual(['es'])
            expect(data.hash["x"]).toEqual(['en'])
            expect(data.options.sorted_keys.length).toBe(2)

            done();
        });
    })
});

test('LRU max size is read from config', (done) => {
    // Setup previous freq-suffix data
    const max_size_value = { "addressesInfo.maxSize": 1234 }
    browser.storage.local.set(max_size_value).then(() => {
        new Promise((resolve, reject) => {
            new AutomaticDictionary.Class({
                window: window,
                compose_window_builder: ComposeWindowStub,
                logLevel: 'error',
                deduceOnLoad: false
            }, async (ad) => {
                let lruHash = await ad.languageAssigner.lruHash._object();
                expect(lruHash.max_size).toBe(1234)
                await ad.languageAssigner.lruHash.set('foo@bar.com', 'es')
                resolve()
            });
        }).then(async () => {
            // Flush memoized data structures
            AutomaticDictionary.instances = [];

            const max_size_value = { "addressesInfo.maxSize": 222 }
            await browser.storage.local.set(max_size_value)

            new AutomaticDictionary.Class({
                window: window,
                compose_window_builder: ComposeWindowStub,
                logLevel: 'error',
                deduceOnLoad: false
            }, async (ad) => {
                let lruHash = await ad.languageAssigner.lruHash._object();
                expect(lruHash.max_size).toBe(222)

                done();
            });
        });
    });
});
