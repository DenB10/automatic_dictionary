import { FreqTable } from "./freq_table.js";
import { PersistentObject } from "./persistent_object.js";
import { FreqSuffix } from "./freq_suffix.js";

export const DomainHeuristic = function(storage, lru_hash, logger, pref_key, ad){
  this.storage = storage;
  this.logger = logger;
  this.freqTablekey = pref_key,
  this.ad = ad;

  this.initFreqSuffix(lru_hash);
}

DomainHeuristic.prototype = {
  initFreqSuffix: function(lru_hash){
    //Build the object that will manage the storage for the object
    var persistent_wrapper = new PersistentObject(
      this.freqTablekey,
      this.storage,
      {
        read:["get","pairs"],
        write:["add","remove"],
        serializer: "toJSON",
        loader:"fromJSON"
      },
      function(){
        return new FreqSuffix();
      }
    );
    this.freq_suffix = persistent_wrapper;
    var _this = this;
    lru_hash.setExpirationCallback(function(pair){
      if (_this.keyIsSingle(pair[0])){
        _this.removeHeuristic(pair[0],pair[1]);
      }
    });
    this.ad.addEventListener('changed-recipient-language-assignment', function(event){
      _this.onRecipientLanguageAssignmentChange(event)
    })
  },

  onRecipientLanguageAssignmentChange: async function(event){
    if(!this.isSingle(event.recipients)) return;

    if(event.previous_language){
      await this.removeHeuristic(event.recipients_key, event.previous_language);
    }
    await this.saveHeuristic(event.recipients_key, event.language);
  },

  isSingle(recipients){
    const empty_cc = !recipients.cc || recipients.cc.length == 0
    return empty_cc && recipients.to.length == 1;
  },
  saveHeuristic: async function(recipient, lang){
    this.logger.debug("saving heuristic for "+ recipient + " to "+ lang);
    var parts = recipient.split("@");
    if( parts[1] ){
      await this.freq_suffix.add(parts[1], lang);
    }
    await this.freq_suffix.pairs();
  },

  removeHeuristic: async function(recipient, lang){
    this.logger.debug("removing heuristic for "+ recipient + " to "+ lang);
    var parts = recipient.split("@");
    if( parts[1] ){
      await this.freq_suffix.remove(parts[1], lang);
    }
  },

  // True when the key represents a single email
  keyIsSingle: function(key){
    let parts = key.split('[cc]');
    let tos_size = parts[0].split(',').length;
    let ccs_empty = parts.length == 1 || parts[1] == ""

    if(tos_size == 1 && ccs_empty){
      return true;
    }
    return false;
  },

  //Tries to guess by other recipients domains
  heuristicGuess: async function(recipients){
    var recipient, parts, rightside, lang,
        freq_table = new FreqTable();
    for(var i=0; i < recipients.length; i++){
      recipient = recipients[i];
      parts = recipient.split("@");
      rightside = parts[parts.length-1];
      this.logger.debug("Looking for heuristic for "+rightside);
      lang = await this.freq_suffix.get(rightside,true);
      if( lang ){
        freq_table.add(lang);
      }
    }
    return freq_table.getFirst();
  },

}