/** Short first names from many cultures. Order is stable; existing agents keep their names. */
export const NAMES: readonly string[] = [
  // The original office names stay first.
  "Tom", "Ada", "Maja", "Noah", "Freja", "Oscar", "Ida", "Lucas", "Clara", "Emil", "Alma", "Viktor", "Sofie", "Felix",
  "Nora", "Anton", "Liv", "Magnus", "Esther", "Karl", "Agnes", "Otto", "Vera", "Aksel", "Ellen", "Hugo", "Selma", "Theo",
  // Europe and the Americas.
  "Aaron", "Abel", "Adam", "Adrian", "Aidan", "Alan", "Albert", "Alex", "Alfred", "Alice", "Alina", "Alisa",
  "Allan", "Alonso", "Alvin", "Amelia", "Amy", "Andre", "Andres", "Anita", "Anna", "Annie", "Ansel", "Arlo",
  "Arthur", "Astrid", "Audrey", "August", "Axel", "Barbara", "Bea", "Bella", "Ben", "Benny", "Berta", "Betty",
  "Bianca", "Bill", "Blanca", "Boris", "Brenda", "Brian", "Bruno", "Caleb", "Callum", "Camila", "Carl", "Carla",
  "Carlos", "Carmen", "Carol", "Celia", "Cesar", "Chloe", "Chris", "Cian", "Cleo", "Colin", "Conrad", "Cora",
  "Craig", "Daisy", "Dalia", "Damon", "Dan", "Dana", "Daniel", "Dante", "Dario", "David", "Della", "Denis",
  "Diana", "Diego", "Dina", "Dora", "Doris", "Dylan", "Earl", "Eden", "Edgar", "Edith", "Edna", "Edward",
  "Eileen", "Einar", "Elena", "Elisa", "Ella", "Elsa", "Elvira", "Emma", "Enid", "Enzo", "Eric", "Erik",
  "Erin", "Esme", "Ethan", "Eva", "Evan", "Eve", "Fabian", "Faye", "Finn", "Fiona", "Flora", "Frank",
  "Fred", "Gabriel", "Gael", "Gemma", "George", "Gina", "Gloria", "Grace", "Greta", "Gustav", "Hanna", "Hans",
  "Harold", "Harry", "Hazel", "Heidi", "Helen", "Henry", "Hilda", "Holly", "Ian", "Ileana", "Ilse", "Ines",
  "Inga", "Ingrid", "Irene", "Iris", "Isaac", "Isabel", "Ivan", "Ivo", "Ivy", "Jack", "Jacob", "Jade",
  "Jaime", "James", "Jan", "Jane", "Janet", "Javier", "Jean", "Jenny", "Jill", "Joan", "Joel", "John",
  "Jonas", "Jorge", "Jose", "Joy", "Juan", "Jude", "Julia", "Julie", "June", "Kai", "Kara", "Kate",
  "Katia", "Kay", "Keira", "Ken", "Kevin", "Kian", "Kira", "Klaus", "Lars", "Laura", "Leah", "Lena",
  "Leo", "Leon", "Leona", "Liam", "Lidia", "Lila", "Lily", "Lina", "Linda", "Lisa", "Lola", "Loren",
  "Lorna", "Louisa", "Luca", "Lucia", "Lucy", "Luis", "Luna", "Lydia", "Mae", "Maia", "Manuel", "Marco",
  "Maria", "Marie", "Mario", "Mark", "Marta", "Martin", "Mary", "Mateo", "Max", "Megan", "Melina", "Mia",
  "Mila", "Milo", "Mira", "Miriam", "Molly", "Monica", "Nadia", "Nancy", "Nell", "Nico", "Nina", "Noel",
  "Nolan", "Norma", "Olga", "Oliver", "Oona", "Orla", "Owen", "Pablo", "Paola", "Pat", "Paul", "Paula",
  "Pedro", "Peter", "Petra", "Philip", "Pia", "Piero", "Pilar", "Quinn", "Rafael", "Ralph", "Raul", "Rene",
  "Rita", "Robin", "Ronan", "Rosa", "Rose", "Roy", "Ruben", "Ruby", "Ruth", "Ryan", "Sally", "Sam",
  "Sandra", "Sara", "Saul", "Sean", "Sergio", "Seth", "Shane", "Sierra", "Silas", "Simon", "Sofia", "Sonia",
  "Stella", "Steve", "Susan", "Sven", "Sylvia", "Tara", "Tessa", "Tina", "Tobias", "Tony", "Tristan", "Troy",
  "Ulla", "Una", "Valeria", "Viggo", "Viola", "Wade", "Walter", "Wendy", "Will", "Willa", "Wyatt", "Yara",
  "Zara", "Zoe", "Zora", "Anja", "Arne", "Bodil", "Dag", "Ebba", "Elin", "Else", "Esben", "Frode",
  "Goran", "Henrik", "Jens", "Kalle", "Karin", "Kirsten", "Lasse", "Lisbeth", "Lotte", "Malte", "Marit", "Mette",
  "Nils", "Per", "Pernille", "Rasmus", "Rune", "Signe", "Siri", "Sten", "Stine", "Tove", "Trine", "Ylva",
  "Aino", "Anu", "Eero", "Eeva", "Eino", "Jari", "Juha", "Kaisa", "Lauri", "Matti", "Minna", "Sanna",
  "Teemu", "Tuuli", "Veli", "Ailsa", "Angus", "Bryn", "Carys", "Dara", "Eira", "Euan", "Fionn", "Iona",
  "Mairi", "Niall", "Rhys", "Rory", "Sian", "Tegan", "Alba", "Aurelia", "Belen", "Domenico", "Elio", "Elsie",
  "Estelle", "Etienne", "Gaston", "Giacomo", "Gio", "Inigo", "Livia", "Lucio", "Maelle", "Mireille", "Nuria", "Remy",
  "Rocco", "Romy", "Sabina", "Sacha", "Sandro", "Thiago", "Yves", "Zelia", "Anya", "Daria", "Ilya", "Katya",
  "Luka", "Marek", "Milena", "Milan", "Misha", "Nikita", "Pavel", "Radek", "Sasha", "Sonja", "Tomas", "Zofia",
  // North Africa, the Middle East, and Central Asia.
  "Adil", "Ahmad", "Aida", "Aisha", "Akram", "Ali", "Amal", "Amani", "Amir", "Amira", "Anas", "Asma",
  "Aziz", "Aziza", "Basma", "Bilal", "Dalal", "Dima", "Farah", "Farid", "Fatima", "Firas", "Hadi", "Hala",
  "Hamza", "Hana", "Hasan", "Hassan", "Hiba", "Iman", "Jamal", "Jana", "Karim", "Khaled", "Laila", "Layan",
  "Leila", "Maha", "Malik", "Marwa", "Mazen", "Mona", "Munir", "Nabil", "Nadim", "Najla", "Nasir",
  "Nawal", "Nizar", "Nour", "Omar", "Rami", "Rania", "Rasha", "Reem", "Rima", "Sahar", "Salim", "Salma",
  "Sami", "Samir", "Sana", "Selim", "Tahir", "Walid", "Wafa", "Yasin", "Yasir", "Youssef", "Zain", "Zaina",
  "Arash", "Azad", "Darya", "Farhad", "Laleh", "Nima", "Pari", "Reza", "Roya", "Shirin", "Sina", "Tala",
  "Avi", "Aviv", "Eli", "Eitan", "Ezra", "Gal", "Hila", "Idan", "Lior", "Noa", "Oren",
  "Ronen", "Shai", "Tal", "Tamar", "Yael", "Yoav", "Ziv", "Aylin", "Ayse", "Bora", "Canan", "Cem",
  "Deniz", "Derya", "Ece", "Emre", "Esra", "Evren", "Eymen", "Ipek", "Kemal", "Leyla", "Mert", "Murat",
  "Nazli", "Ozan", "Pelin", "Seda", "Sema", "Serkan", "Sevgi", "Tunc", "Umut", "Yigit", "Zeki", "Zeynep",
  "Alim", "Arman", "Asel", "Ayan", "Azamat", "Bayan", "Damir", "Daniyar", "Dilara", "Elmira", "Ruslan",
  // South Asia.
  "Aarav", "Aarti", "Abhay", "Aditi", "Ajay", "Akash", "Amita", "Amit", "Anil", "Anjali", "Anmol", "Anup",
  "Arjun", "Arun", "Asha", "Ashok", "Avani", "Bala", "Bhavna", "Chitra", "Deepa", "Dev", "Devi", "Dhruv",
  "Divya", "Gauri", "Geeta", "Gopal", "Hari", "Harish", "Hema", "Indira", "Isha", "Jaya", "Kajal", "Kamal",
  "Kavya", "Kiran", "Kunal", "Lata", "Leela", "Mala", "Manju", "Manoj", "Meena", "Meera", "Mohan", "Naina",
  "Neel", "Neha", "Nikhil", "Nila", "Nisha", "Nitin", "Pooja", "Pranav", "Priya", "Radha", "Rahul", "Raj",
  "Rajan", "Rajiv", "Rakesh", "Rani", "Ravi", "Rekha", "Rhea", "Rishi", "Rohit", "Rupa", "Sagar", "Sanjay",
  "Sanya", "Sarita", "Seema", "Shreya", "Sonal", "Sudha", "Sunil", "Suraj", "Tanya", "Uday", "Uma", "Varun",
  "Veena", "Vijay", "Vikram", "Vinay", "Zoya", "Anika", "Fariha", "Iqbal", "Kubra", "Mahira", "Nazia", "Rafi",
  "Saira", "Sajid", "Shazia", "Usman", "Zia", "Champa", "Dilan", "Nalin", "Nimal", "Saman",
  // East and Southeast Asia.
  "Ai", "Akiko", "Aki", "Akira", "Aoi", "Asuka", "Aya", "Ayaka", "Chika", "Emi", "Eri", "Haru",
  "Haruka", "Hiro", "Hitomi", "Jun", "Kaori", "Keiko", "Kenji", "Kiko", "Kimi", "Koji", "Mai", "Maki",
  "Mariko", "Mei", "Mika", "Miki", "Mio", "Misaki", "Naoki", "Nao", "Nori", "Rei", "Ren", "Riku",
  "Rina", "Rio", "Saki", "Sakura", "Sora", "Taichi", "Taro", "Tomo", "Yoko", "Yori", "Yui", "Yuki",
  "Yuna", "Yuri", "Bao", "Bo", "Chen", "Fang", "Fei", "Hao", "Hong", "Hui", "Jia", "Jing",
  "Lan", "Lei", "Li", "Lian", "Lin", "Ling", "Min", "Ming", "Na", "Ning", "Ping", "Qian",
  "Qing", "Rui", "Shan", "Tao", "Tian", "Wei", "Wen", "Xia", "Xin", "Yan", "Yi", "Ying",
  "Yong", "Yuan", "Yue", "Yun", "Zhen", "Ara", "Bomi", "Dae", "Eun", "Hae",
  "Jae", "Jisoo", "Joon", "Mina", "Nari", "Seul", "Soo", "Sujin", "Taeyang", "Yejin", "Anh", "Binh",
  "Chi", "Dao", "Duc", "Giang", "Ha", "Hanh", "Hien", "Hoa", "Khanh", "Lam", "Lien", "Linh",
  "Loan", "Long", "Nam", "Nga", "Ngoc", "Nhi", "Quyen", "Son", "Thao", "Thi", "Thu",
  "Trang", "Trinh", "Tuan", "Van", "Vinh", "Anong", "Araya", "Chai", "Kanya", "Mali", "Niran", "Pim",
  "Suda", "Suri", "Aditya", "Agung", "Ayu", "Bayu", "Budi", "Citra", "Dewi", "Dian", "Eka", "Fajar",
  "Intan", "Made", "Putri", "Raden", "Ratna", "Rizal", "Sari", "Surya", "Wayan", "Adi", "Aira",
  "Lani", "Luz", "May", "Teresita", "Thea", "Zena", "Aung", "Hla", "Khin", "Mya", "Nwe",
  "Soe", "Thant", "Thiri", "Tun", "Win", "Zaw",
  // Africa and the Pacific.
  "Abena", "Abeni", "Adaeze", "Ade", "Adwoa", "Afia", "Akua", "Ama", "Amina", "Amadi", "Amara", "Ayo",
  "Ayodele", "Azuka", "Binta", "Chidi", "Chima", "Ebele", "Efua", "Esi", "Femi", "Folami", "Funmi",
  "Ife", "Ifeoma", "Ikenna", "Imani", "Jelani", "Juma", "Kato", "Kofi", "Kojo", "Kwame", "Kwesi", "Lerato",
  "Mandla", "Masego", "Nala", "Nana", "Nia", "Nneka", "Obi", "Ola", "Olu", "Sade", "Sefu", "Sola",
  "Tayo", "Tendai", "Thabo", "Tumi", "Uche", "Yemi", "Yewande", "Zola", "Zuri", "Alem", "Almaz", "Aster",
  "Dawit", "Desta", "Hirut", "Kebede", "Liya", "Meron", "Mesfin", "Mulu", "Selam", "Tadesse",
  "Tesfay", "Zelalem", "Awa", "Cheikh", "Demba", "Fanta", "Fatou", "Ibra", "Issa", "Kadi", "Lamine", "Mame",
  "Mariama", "Moussa", "Ndeye", "Ousmane", "Rokhaya", "Sadio", "Salif", "Samba", "Sira", "Aroha", "Hemi", "Kiri",
  "Manaia", "Mere", "Moana", "Nikau", "Rangi", "Rawiri", "Tane", "Whetu", "Ailani", "Kailani", "Kaleo", "Keanu",
  "Keola", "Kiana", "Leilani", "Liko", "Malia", "Manu", "Nohea", "Pua", "Tasi", "Teuila", "Vaea",
];

export const NAME_REUSE_MS = 3 * 24 * 60 * 60 * 1000;

export interface NameRecord {
  id: string;
  name: string;
  teamId: string | null;
  removed: boolean;
  lastSeenAt: string;
}

/** Prefer unused names, then stale unplaced records, then numbers. No existing active name changes. */
export function allocateName(records: readonly NameRecord[], protectedIds: ReadonlySet<string>, start: number, now: number): {
  name: string;
  retired?: { id: string; name: string };
} {
  const taken = new Set(records.map((r) => r.name.toLowerCase()));
  const ordered = Array.from({ length: NAMES.length }, (_, i) => NAMES[(start + i) % NAMES.length]!);
  const free = ordered.find((name) => !taken.has(name.toLowerCase()));
  if (free) return { name: free };
  for (const name of ordered) {
    const owners = records.filter((r) => r.name.toLowerCase() === name.toLowerCase());
    // Be conservative about any pre-existing duplicate custom names.
    if (owners.length !== 1) continue;
    const old = owners[0]!;
    if (old.teamId || old.removed || protectedIds.has(old.id) || !(Date.parse(old.lastSeenAt) <= now - NAME_REUSE_MS)) continue;
    let earlier = `${old.name} (earlier)`;
    for (let n = 2; taken.has(earlier.toLowerCase()); n++) earlier = `${old.name} (earlier ${n})`;
    return { name, retired: { id: old.id, name: earlier } };
  }
  const base = ordered[0]!;
  let name = `${base} ${taken.size + 1}`;
  for (let n = taken.size + 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return { name };
}
