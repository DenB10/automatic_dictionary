var obj = new AutomaticDictionary.Lib.FreqSuffix({})
obj.add("foo.com","X");
obj.add("abc.com","X");
obj.add("xyz.com","Y");

assert.equal("Y", obj.get("xyz.com"));
assert.equal("X", obj.get("com") );

obj.add("a.foo.com","a");
obj.add("b.foo.com","b");
obj.add("c.foo.com","c");

assert.equal("a", obj.get("a.foo.com"));
//Arbitrary first item
assert.equal("X", obj.get("foo.com"));

//Update and win A at com
obj.add("foo.com","A");
obj.add("abc.com","A");
obj.add("abc.com","A");
assert.equal("A", obj.get("com"));

obj.remove