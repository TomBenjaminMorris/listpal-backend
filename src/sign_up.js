module.exports.handler = async (event) => {
  console.log("TTT event: ", event)
  console.log("TTT event.request: ", event.request)
  console.log("TTT event.request.userAttributes: ", event.request.userAttributes)
  const userID = "u#" + event.request.userAttributes.sub
  const email = event.request.userAttributes.email
  try {
    console.log("TTT attempting user creation...")
    const request = new Request("https://api.vinsp.in/new-user", {
      method: "POST",
      body: JSON.stringify({ userID: userID, email: email, name: "" }),
    });

    const response = await fetch(request);
    if (response) {
      console.log("TTT response.status:", response.status);
      console.log("TTT response:", response.data);
    }
  } catch (err) {
    console.error("Error getting data: ", err);
    throw err;
  }
  return event;
};
