let obj ={
  name: 'Sanek',
  age:14,
  sayHI(){
    console.log('hello');
  }
}
console.log(JSON.parse(JSON.stringify(obj)));